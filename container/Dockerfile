# uploadmycode compile service: Debian + arduino-cli + the AVR toolchain, plus
# clang-format for the Auto indent button, serving container/server.js.
# Everything is version-pinned and checksum-verified so a rebuild next year
# produces the same compiler the class used today.
#
# Cloudflare Containers run linux/amd64 only, hence the explicit --platform.
# Build context is ./container (see wrangler.jsonc image_build_context).
#
# To add a library to the classroom allowlist: add an `arduino-cli lib install`
# line below with an exact version, then redeploy. That is the whole procedure.

FROM --platform=linux/amd64 debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# --- pins -------------------------------------------------------------------
# Bump a version here and update the matching sha256 from the project's release
# checksums (nodejs.org/dist/vX/SHASUMS256.txt, arduino-cli's <ver>-checksums.txt).
ARG NODE_VERSION=24.19.0
ARG NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
ARG ARDUINO_CLI_VERSION=1.5.1
ARG ARDUINO_CLI_SHA256=28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b
ARG AVR_CORE_VERSION=1.8.8
ARG SERVO_VERSION=1.3.0
ARG LIQUIDCRYSTAL_VERSION=1.0.7
ARG LCD_I2C_VERSION=1.1.2
ARG STEPPER_VERSION=1.1.3

ENV DEBIAN_FRONTEND=noninteractive

# curl + xz-utils to fetch the pinned tarballs, ca-certificates to verify TLS,
# libstdc++6 because the prebuilt node and avr-gcc binaries link against it.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		libstdc++6 \
		xz-utils \
	&& rm -rf /var/lib/apt/lists/*

# --- Node.js ----------------------------------------------------------------
# server.js uses Node built-ins only, so this is the runtime and nothing else.
RUN curl -fsSL -o /tmp/node.tar.xz \
		"https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
	&& echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
	&& tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
	&& rm /tmp/node.tar.xz \
	&& node --version

# --- arduino-cli ------------------------------------------------------------
RUN curl -fsSL -o /tmp/arduino-cli.tar.gz \
		"https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/arduino-cli_${ARDUINO_CLI_VERSION}_Linux_64bit.tar.gz" \
	&& echo "${ARDUINO_CLI_SHA256}  /tmp/arduino-cli.tar.gz" | sha256sum -c - \
	&& tar -xzf /tmp/arduino-cli.tar.gz -C /usr/local/bin arduino-cli \
	&& rm /tmp/arduino-cli.tar.gz \
	&& arduino-cli version

# Keep the toolchain out of $HOME so it does not depend on who runs the process.
# The build cache is pinned here too, so the warm-up compile below survives into
# the image instead of landing in a /tmp that the runtime may not keep.
ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
	ARDUINO_DIRECTORIES_USER=/opt/arduino/user \
	ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/downloads \
	ARDUINO_BUILD_CACHE_PATH=/opt/arduino/cache

# --- AVR core and the library allowlist -------------------------------------
# Baked into the image: students cannot install libraries, and a compile never
# touches the network. The downloads cache is dropped once everything is in.
RUN arduino-cli core update-index \
	&& arduino-cli core install "arduino:avr@${AVR_CORE_VERSION}" \
	&& arduino-cli lib install "Servo@${SERVO_VERSION}" \
	&& arduino-cli lib install "LiquidCrystal@${LIQUIDCRYSTAL_VERSION}" \
	&& arduino-cli lib install "LiquidCrystal I2C@${LCD_I2C_VERSION}" \
	&& arduino-cli lib install "Stepper@${STEPPER_VERSION}" \
	&& rm -rf /opt/arduino/downloads \
	&& arduino-cli core list \
	&& arduino-cli lib list

# --- clang-format (the Auto indent button) ----------------------------------
# Debian bookworm's own package, which is why there is no checksum here: apt
# already verifies the archive signature, and the base image is pinned by digest
# above, so this resolves to the same build every time.
#
# The version that lands is **clang-format 14.0.6** — the build log line reads
# exactly `Debian clang-format version 14.0.6`, from package
# clang-format 1:14.0-55.7~deb12u1 depending on clang-format-14 1:14.0.6-12.
# `clang-format --version` runs below so a rebuild that ever produces something
# else says so in the build log, instead of quietly restyling every student's
# sketch a different way one morning.
#
# It sits here, after the toolchain, on purpose: adding it to the apt block at
# the top would throw away the Node, arduino-cli and AVR-core layers on every
# rebuild for the sake of a 30 MB package.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends clang-format \
	&& rm -rf /var/lib/apt/lists/* \
	&& clang-format --version

# --- the user the server runs as (T5) ---------------------------------------
# Everything above needs root to install into /usr/local and /opt. Nothing below
# does. The compile server takes untrusted text from students and hands it to
# avr-gcc, so it spends its whole life as an ordinary user that owns only the
# arduino toolchain directories and /app.
#
# The warm-up compile below runs as this user on purpose: it fills
# ARDUINO_BUILD_CACHE_PATH with files the runtime user already owns, so the
# first real compile reuses the cache instead of rebuilding the core.
RUN useradd --create-home --home-dir /home/uploader --shell /usr/sbin/nologin --uid 10001 uploader \
	&& mkdir -p /opt/arduino/cache /app \
	&& chown -R uploader:uploader /opt/arduino /app

# Explicit rather than inherited, so arduino-cli never writes to / by accident.
ENV HOME=/home/uploader
USER uploader

# --- warm-up compile --------------------------------------------------------
# Compiling the AVR core is the slow half of a first compile. Doing it here bakes
# the result into the image, so the first student after a container cold start
# pays a warm compile instead of a cold one. Measured on Windows with the same
# pins: 2.9 s cold, 1.3 s warm, for about 1 MB of cache.
RUN mkdir -p /tmp/warmup/sketch \
	&& printf 'void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() { digitalWrite(LED_BUILTIN, HIGH); delay(1000); digitalWrite(LED_BUILTIN, LOW); delay(1000); }\n' \
		> /tmp/warmup/sketch/sketch.ino \
	&& arduino-cli compile --fqbn arduino:avr:uno --output-dir /tmp/warmup/out /tmp/warmup/sketch \
	&& rm -rf /tmp/warmup

# --- the server -------------------------------------------------------------
WORKDIR /app
# package.json only marks server.js as an ES module. It has no dependencies, so
# there is no npm install step. .clang-format is the Auto indent style and is
# read from /app at request time, not baked into the binary. Copied last so
# editing any of the three does not invalidate the toolchain or warm-up layers
# above.
COPY --chown=uploader:uploader package.json server.js .clang-format /app/

ENV PORT=8080
EXPOSE 8080

CMD ["node", "/app/server.js"]

// Draws the uploadmycode icon: the family robot, the first of the four, with its side vents and the
// upload-arrow hat. The look (ink outline, hand-drawn wobble) lives in scripts/icon-kit.mjs, shared
// by all four sites. Usage: node scripts/make-icons.mjs web/public
import { circle, curve, inked, poly, rrect, tag, tile, writeIcons } from './icon-kit.mjs';

const OUT = process.argv[2] || '.';
// Family colours: grey face, deep tile of the site's colour, arrow in a brighter tint of it.
const BG = '#134E4A', FACE = '#AEB6C0', ARROW = '#2DD4BF', INK = '#06201E';
const WHITE = '#FFFFFF', DARK = '#0F3D40';

writeIcons(OUT, [
  tile(BG),
  ...tag('hat', inked([poly([[32, 5], [23, 15], [41, 15]], ARROW), rrect(29, 14, 6, 7, 0, ARROW)], INK)),
  // side vents: three on each side, a touch uneven
  ...tag('vent', inked([
    rrect(7.6, 27, 6.4, 3, 1.2, FACE), rrect(8.2, 34, 5.8, 3, 1.2, FACE), rrect(7.8, 41, 6.2, 3, 1.2, FACE),
    rrect(50, 27, 6.2, 3, 1.2, FACE), rrect(50, 34, 6.6, 3, 1.2, FACE), rrect(50, 41, 5.9, 3, 1.2, FACE),
  ], INK)),
  ...inked([rrect(14, 20, 36, 31, 6.5, FACE)], INK),
  ...tag('blink', [circle(25, 33, 3.2, DARK), circle(39, 33, 3.2, DARK), circle(26.1, 31.9, 1, WHITE), circle(40.1, 31.9, 1, WHITE)]),
  curve(24, 41, 32, 48, 40, 41, 3, DARK),
], 'uploadmycode icon: the family robot with side vents and the upload-arrow hat.', `
  .hat { animation: upload 0.9s ease-in-out infinite; }
  @keyframes upload { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3.5px); } }
  .vent { animation: vent 0.9s ease-in-out infinite; }
  @keyframes vent { 50% { transform: scaleX(1.25); } }`);

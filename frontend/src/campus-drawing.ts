import type { Translator } from './locale';

type Point = [number, number];

export const officialMap = 'https://studyathkustgz.hkust-gz.edu.cn/detail-819';
export const mapWidth = 1000;
export const mapHeight = 576;

export const stationLocations: Record<string, Point> = {
  a: [505, 420],
  b: [679, 436],
  c: [870, 433],
};

const grounds = [
  'M0 0H1000V576H0Z',
  'M4 18L176 12 164 60 39 78 12 171Z',
  'M454 16L645 14 628 77 599 179 473 184Z',
  'M474 226L611 219 606 312 461 316Z',
  'M35 332L145 304 180 357 145 412 36 412Z',
  'M35 455L228 451 221 526 127 523 81 474Z',
  'M253 449L425 443 421 521 251 524Z',
  'M798 199L915 206 935 317 828 309Z',
  'M905 462L963 456 987 516 933 521Z',
];

const roads = [
  'M-20 544C166 540 310 542 461 538S794 549 1020 522',
  'M38 -16C30 54 15 91 15 178L27 416Q30 433 56 433H432',
  'M421 -16C444 63 471 117 468 214S437 344 435 421L433 545',
  'M1012 39L853 38Q820 40 831 73L924 306 943 423 961 507',
  'M285 432H535Q583 431 633 428H840Q893 427 921 403',
  'M438 326L906 324',
  'M461 198L617 200Q650 199 677 194L901 187',
  'M238 538L239 460Q240 445 236 439',
  'M220 79Q212 148 216 231T245 316',
  'M293 82Q314 161 304 261L293 306',
  'M472 46L609 162M470 297L612 222M637 24L615 174',
  'M477 509L882 509M785 329L784 427M642 332L642 431M620 434L620 518',
];

const westLabs: Point[] = [[104, 105], [101, 167], [104, 228], [112, 290]];
const eastLabs: Point[] = [[366, 104], [373, 167], [372, 228], [365, 291]];

const residences: { label: string; x: number; y: number; angle: number }[] = [
  { label: '1A', x: 493, y: 363, angle: 20 },
  { label: '1B', x: 550, y: 347, angle: 0 },
  { label: '3', x: 687, y: 380, angle: 0 },
  { label: '5B', x: 817, y: 347, angle: 0 },
  { label: '5A', x: 820, y: 390, angle: 0 },
  { label: '5C', x: 893, y: 371, angle: -13 },
  { label: '2A', x: 492, y: 482, angle: 14 },
  { label: '2B', x: 571, y: 463, angle: 0 },
  { label: '4A', x: 678, y: 470, angle: 0 },
  { label: '4B', x: 742, y: 485, angle: 0 },
  { label: '6A', x: 817, y: 464, angle: 0 },
  { label: '6B', x: 879, y: 484, angle: 0 },
  { label: '6C', x: 944, y: 468, angle: 0 },
];

function area(ctx: CanvasRenderingContext2D, path: string, fill: string, border?: string) {
  const shape = new Path2D(path);
  ctx.fillStyle = fill;
  ctx.fill(shape);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 1.2;
    ctx.stroke(shape);
  }
}

function line(ctx: CanvasRenderingContext2D, path: string, color: string, width: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(new Path2D(path));
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 17, color = '#283f37') {
  ctx.font = `650 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function building(
  ctx: CanvasRenderingContext2D, text: string, [x, y]: Point, width: number,
  height: number, angle: number, palette: 'academic' | 'residential' | 'civic',
) {
  const colors = {
    academic: ['#f5f3e8', '#909e94'],
    residential: ['#f3e5d6', '#b88770'],
    civic: ['#e4e9dc', '#7b9987'],
  }[palette];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle * Math.PI / 180);
  const l = -width / 2;
  const t = -height / 2;
  const footprint = `M${l} ${t}h${width * .71}v5h${width * .29}v${height - 5}h-${width}Z`;
  ctx.translate(2, 3);
  area(ctx, footprint, '#4d65522c');
  ctx.translate(-2, -3);
  area(ctx, footprint, colors[0], colors[1]);
  line(ctx, `M${l + 5} ${t + 5}h${width * .57}`, '#ffffffc9', 1.3);
  ctx.restore();
  label(ctx, text, x, y + 2, palette === 'residential' ? 15 : 18);
}

function oval(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, angle: number, color: string) {
  ctx.beginPath();
  ctx.ellipse(x, y, width, height, angle * Math.PI / 180, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export function drawCampus(ctx: CanvasRenderingContext2D, t: Translator) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  grounds.forEach((path, index) => area(ctx, path, index === 0 ? '#e8e5d7' : '#d8dfce', index ? '#bfc9b7' : undefined));
  for (let x = 0; x < mapWidth; x += 38) line(ctx, `M${x} 0V${mapHeight}`, '#637b6b17', 1);
  for (let y = 0; y < mapHeight; y += 38) line(ctx, `M0 ${y}H${mapWidth}`, '#637b6b17', 1);
  area(ctx, 'M840 -25C848 58 909 136 936 235S977 355 1020 401L1037 357C994 314 989 253 969 192S900 43 882 -25Z', '#9bb6b6', '#819d9b');
  area(ctx, 'M-20 455C67 450 106 478 134 519L111 542Q58 485 -20 485Z', '#a8bfc2', '#8fa9ab');
  area(ctx, 'M219 -10Q231 50 231 110T227 217Q214 256 237 298L252 296Q235 254 243 223T248 115Q252 45 236 -10Z', '#a9bfc0', '#8fa9ab');
  const residenceBoundary = 'M451 326L904 324 960 435 965 510 457 529Z';
  area(ctx, residenceBoundary, '#c77f4c17');

  for (const [index, path] of roads.entries()) {
    const width = index === 0 ? 22 : index < 7 ? 9 : 5;
    line(ctx, path, index === 0 ? '#9ca59b' : '#bec6b7', width + 2);
    line(ctx, path, index === 0 ? '#c6c9bb' : '#f9f6e9', width);
    if (index === 0) line(ctx, path, '#f9f6e9', 1.4);
  }
  ctx.save();
  ctx.setLineDash([7, 6]);
  line(ctx, residenceBoundary, '#a06544a6', 1.6);
  ctx.restore();

  for (let i = 0; i < 42; i += 1) {
    const x = 456 + (i * 119) % 148;
    const y = 31 + (i * 47) % 273;
    if (y < 177 || y > 230) {
      oval(ctx, x + 1, y + 1, 3 + i % 3, 3 + i % 3, 0, '#4f6e5729');
      oval(ctx, x, y, 2.6 + i % 3, 2.6 + i % 3, 0, '#7f9a79');
    }
  }

  westLabs.forEach(([x, y], i) => building(ctx, 'W' + (4 - i), [x, y], 128, 32, i === 0 ? 12 : -7, 'academic'));
  eastLabs.forEach(([x, y], i) => building(ctx, 'E' + (4 - i), [x, y], 130, 32, i < 2 ? -10 : 9, 'academic'));
  building(ctx, t('图书馆'), [240, 69], 92, 33, 0, 'civic');
  oval(ctx, 270, 155, 23, 29, 18, '#e4d4ae');
  label(ctx, t('食堂'), 270, 156, 15);
  label(ctx, t('演讲厅'), 242, 198, 14);

  area(ctx, 'M172 396Q190 331 236 330Q285 330 311 400L295 409Q272 350 236 350Q200 350 189 403Z', '#eeeade', '#91a095');
  oval(ctx, 239, 406, 27, 27, 0, '#bac9b7');
  oval(ctx, 239, 406, 19, 19, 0, '#9ab4b6');
  oval(ctx, 239, 406, 9, 9, 0, '#e2ca9c');
  label(ctx, t('行政大楼'), 237, 362, 16);
  building(ctx, t('活动中心'), [368, 372], 110, 34, 15, 'civic');

  oval(ctx, 754, 99, 100, 64, 43, '#a27058');
  oval(ctx, 754, 99, 97, 61, 43, '#c78f73');
  oval(ctx, 754, 99, 93, 57, 43, '#ecd2b9');
  oval(ctx, 754, 99, 92, 56, 43, '#c79073');
  oval(ctx, 754, 99, 86, 50, 43, '#f3ddbd');
  oval(ctx, 754, 99, 84, 48, 43, '#aabf9d');
  oval(ctx, 722, 248, 79, 47, -24, '#4d65522c');
  oval(ctx, 719, 244, 79, 47, -24, '#95a990');
  oval(ctx, 719, 244, 76, 44, -24, '#e5e9db');
  label(ctx, t('体育场'), 754, 99, 19);
  label(ctx, t('体育馆'), 719, 243, 18);
  label(ctx, t('体育区'), 867, 120, 15, '#436747');
  label(ctx, t('教学科研区'), 114, 41, 16, '#3c5c64');
  label(ctx, t('南区宿舍'), 685, 312, 17, '#86492f');

  residences.forEach(({ label: name, x, y, angle }) => building(ctx, name, [x, y], 57, 25, angle, 'residential'));
  label(ctx, t('主入口'), 238, 519, 17);
  label(ctx, t('笃学路'), 615, 551, 15, '#455d53');
}

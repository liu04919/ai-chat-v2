export const ART_WIDTH = 1672;
export const ART_HEIGHT = 941;
export const VERTEX_STRIDE = 15;
type Point = readonly [number, number];

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export function smooth(min: number, max: number, value: number) {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

// 坐标来自原壁纸，基于 1672 × 941 原图；改图时必须同步调整绑定区域。
const regions: Record<string, readonly Point[]> = {
  head: [[273, 187], [286, 87], [290, 10], [313, 29], [338, 94], [404, 85], [420, 26], [464, 49], [503, 97], [516, 149], [567, 192], [561, 256], [513, 330], [464, 365], [388, 347], [320, 309], [267, 264]],
  torso: [[353, 318], [476, 321], [549, 358], [577, 443], [555, 544], [591, 630], [526, 670], [382, 624], [340, 548], [331, 426]],
  hairRight: [[500, 187], [558, 227], [590, 301], [678, 359], [714, 401], [770, 478], [879, 539], [955, 601], [1034, 691], [1113, 766], [1128, 839], [1077, 814], [973, 787], [860, 716], [768, 642], [696, 594], [608, 541], [566, 450], [515, 390], [479, 312]],
  hairLeft: [[311, 174], [338, 208], [333, 287], [310, 333], [303, 380], [263, 429], [226, 474], [166, 494], [127, 480], [198, 439], [243, 373], [273, 298]],
  hand: [[704, 422], [722, 386], [779, 351], [816, 347], [820, 363], [851, 357], [866, 368], [837, 396], [797, 417], [749, 427], [720, 457]],
  wing: [[12, 407], [91, 358], [172, 318], [243, 294], [265, 298], [223, 334], [202, 389], [169, 435], [121, 452], [64, 458], [16, 442]],
  // 左下方有鳞片的弯尾，不包含右侧裙摆与前景花丛。
  tail: [[180, 686], [184, 702], [163, 723], [132, 741], [143, 763], [170, 782], [208, 797], [239, 820], [264, 850], [274, 878], [249, 899], [209, 894], [169, 873], [148, 847], [118, 834], [105, 808], [75, 792], [66, 765], [32, 748], [26, 726], [39, 702], [65, 684], [98, 674], [139, 667], [165, 671]],
  sleeve: [[688, 458], [724, 455], [731, 520], [780, 595], [799, 666], [776, 720], [850, 796], [919, 840], [1049, 879], [1126, 940], [666, 940], [622, 771], [633, 637], [636, 541]],
  blossomsLeft: [[0, 0], [259, 0], [216, 57], [237, 120], [207, 189], [183, 137], [157, 216], [124, 196], [137, 100], [99, 102], [100, 201], [69, 256], [44, 312], [0, 296]],
  blossomsRight: [[1424, 0], [1672, 0], [1672, 299], [1637, 278], [1597, 179], [1581, 70], [1549, 135], [1529, 150], [1509, 74]],
  blossomsMiddle: [[438, 0], [655, 0], [630, 70], [604, 150], [565, 204], [543, 180], [567, 110], [504, 63], [476, 118], [453, 102]],
  blossomsFarRight: [[1613, 323], [1672, 297], [1672, 613], [1644, 595], [1626, 535], [1643, 468], [1592, 451], [1580, 403]],
};

function polygonWeight(x: number, y: number, points: readonly Point[], feather: number) {
  let inside = false;
  let distance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax, dy = by - ay;
    const q = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    distance = Math.min(distance, Math.hypot(x - ax - q * dx, y - ay - q * dy));
  }
  return smooth(-feather, feather, inside ? distance : -distance);
}

export function createMesh() {
  const cols = 240, rows = 136;
  const vertices = new Float32Array((cols + 1) * (rows + 1) * VERTEX_STRIDE);
  const indices = new Uint16Array(cols * rows * 6);
  let offset = 0;
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= cols; x++) {
    const px = x / cols * ART_WIDTH, py = y / rows * ART_HEIGHT;
    const head = polygonWeight(px, py, regions.head, 38), torso = polygonWeight(px, py, regions.torso, 48);
    const right = polygonWeight(px, py, regions.hairRight, 30) * (1 - head * .5);
    const left = polygonWeight(px, py, regions.hairLeft, 22) * (1 - head * .6);
    const hand = polygonWeight(px, py, regions.hand, 20), wing = polygonWeight(px, py, regions.wing, 30);
    const sleeve = polygonWeight(px, py, regions.sleeve, 42);
    // 尾根压在裙摆后面，固定根部；画面边缘与遮挡处平滑收回，避免拉扯接缝。
    const tail = polygonWeight(px, py, regions.tail, 18) * smooth(675, 845, py);
    const middleBlooms = polygonWeight(px, py, regions.blossomsMiddle, 20);
    const leftBlooms = polygonWeight(px, py, regions.blossomsLeft, 24), rightBlooms = polygonWeight(px, py, regions.blossomsRight, 26);
    const farRightBlooms = polygonWeight(px, py, regions.blossomsFarRight, 25);
    const edge = smooth(0, 55, Math.min(px, py, ART_WIDTH - px, ART_HEIGHT - py));
    const depth = Math.max(head, torso, right, left, hand, wing * .8, sleeve * .6) * edge;
    const border = smooth(0, 15, Math.min(px, ART_WIDTH - px));
    vertices.set([px, py, head * edge, torso * edge, right * edge, left * edge, hand * edge, wing * edge, sleeve * edge, middleBlooms, leftBlooms * border, depth, rightBlooms * border, farRightBlooms * border, tail * edge], offset);
    offset += VERTEX_STRIDE;
  }
  offset = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const a = y * (cols + 1) + x, b = a + 1, c = a + cols + 1, d = c + 1;
    indices.set([a, c, b, b, c, d], offset);
    offset += 6;
  }
  return { vertices, indices };
}

export function getViewport(width: number, height: number, pixelRatio: number) {
  const scale = Math.max(width / ART_WIDTH, height / ART_HEIGHT);
  return {
    width, height, scale,
    // 与静态图 object-position: 42% center 保持一致，接替时不跳位。
    originX: (width - ART_WIDTH * scale) * .42,
    originY: (height - ART_HEIGHT * scale) / 2,
    dpr: Math.min(pixelRatio || 1, 2, Math.sqrt(4_200_000 / (width * height))),
  };
}
export type Viewport = ReturnType<typeof getViewport>;

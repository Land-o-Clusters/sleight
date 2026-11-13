// Explicit stage joints in 192x208 body space, or 320x208 for the full-length lying family.
// The anime and paper renderers keep their own parts, faces, linework and materials.
import { f } from './svg.mjs';

const unit = ([x, y]) => { const d = Math.hypot(x, y) || 1; return [x / d, y / d]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export function stageRig(D, p, B) {
  const { name, posture, frame: i, frames: n, energy: e = 1 } = p.stage;
  const wave = Math.sin(i / n * 2 * Math.PI) * e;
  const adult = B.head < 0.9, fox = D.species === 'fox';
  let sh = [96, B.shY], hip = [96, B.hipY], head = [96, B.headY], tilt = 0;
  let elbows, hands, knees, feet, angle = 0, headTilt = 0, headTurn = 0;
  const face = { ...p.face }, props = [], fx = [];
  const is = key => name === `stage-${key}`;
  if (posture === 'lie') {
    const sleep = is('sleep'), peek = is('lie-peek');
    hip = [132, 140]; sh = [202, 132]; head = [254, sleep ? 122 : peek ? 118 : 104];
    angle = 84; headTilt = sleep ? 12 : -5 + wave * 2; headTurn = 0.25;
    knees = [[76, 136], [82, 148]];
    feet = sleep ? [[30, 139], [36, 151]] : [[54, 78 - wave * 10], [64, 92 + wave * 12]];
    elbows = [[218, 151], [230, 150]]; hands = [[245, 134], [266, 145]];
    if (is('lie-reach')) {
      hands[1] = [[262, 147], [274, 173], [279, 183], [264, 148]][i];
      elbows[1] = [248, 153];
      p.arms.r.hand = 'point';
    }
    if (peek) { hands = [[251, 154], [284, 154]]; headTurn = 0.5; face.look = [0.5, 0.9]; }
    if (sleep) { face.eyes = 'closed'; face.mouth = 'smile'; }
    else if (is('lie') && i === 1) face.eyes = 'closed';
    else face.look = [0.35, 0.6];
  } else if (posture === 'sit') {
    // The signature seat from the reference video: a three-quarter sit on the edge, both legs over it to the
    // viewer's left with the knees well clear of the torso, the body leaning back on a hand planted behind.
    // In silhouette the knees jut out past the hips and the shins hang, so it never reads as a stand.
    const shY = adult ? 97 : 108;
    hip = [96, 142]; sh = [100, shY]; head = [101, adult ? 62 : 66]; angle = 5; headTilt = 3;
    const drop = D.style === 'paper' ? 5 : 0; // Folded feet include a cut edge and two paper shadows.
    knees = [[58, 158], [70, 152]]; feet = [[66 + 7 * wave, 191 - drop], [80 - 7 * wave, 186 - drop]];
    elbows = [[60, 131], [134, 125]]; hands = [[74, 150], [140, 138]];
    if (is('sit-notes')) {
      sh = [97, shY]; head = [96, adult ? 63 : 67]; angle = 0;
      elbows = [[52, 134], [128, 126]]; hands = [[58, 156], [90 + (i % 3) * 3, 144 + (i % 2) * 3]];
      headTilt = 8; face.look = [-0.4, 0.8];
      props.push({ type: 'notes', x: 78, y: 153, writing: i });
    }
    if (is('think')) {
      elbows = [[60, 131], [134, 115]]; hands = [[74, 150], [115, adult ? 91 : 99]];
      headTilt = -7; face.look = [0.6, -0.7]; p.arms.r.hand = 'fist';
    }
    if (is('wait')) {
      elbows = [[53, 111], [141, 111]]; hands = [[54, 88], [140, 88]];
      props.push({ type: 'card', x: 82, y: 140, rot: i % 2 ? 2 : -2 });
      face.brows = 'up';
      fx.push({ type: 'ask', x: 154, y: 50 });
    }
    if (is('cheer')) {
      elbows = i === 2 ? [[55, 112], [139, 112]] : [[43, 87], [151, 87]];
      hands = i === 2 ? [[49, 96], [145, 96]] : [[36, 51], [158, 51]];
      // The hold frame kicks both legs out: a seated jump for joy.
      if (i === 1) { knees = [[54, 148], [68, 143]]; feet = [[34, 130], [48, 122]]; }
      p.arms.l.hand = p.arms.r.hand = 'palm'; face.eyes = 'happy'; face.mouth = 'grin';
    }
    if (is('paused')) {
      hands = [[86, 137], [110, 137]]; elbows = [[62, 136], [134, 134]];
      props.push({ type: 'mug', x: 98, y: i < 3 ? 136 - i * 10 : 116 });
      face.eyes = i === 4 ? 'half' : 'open'; headTilt = 3;
    }
    if (is('startle')) {
      // A frontal jolt off the seat: hips lift 4 px, feet fly apart.
      hip = [96, 138]; sh = [96, shY - 4]; head = [96, adult ? 58 : 62]; angle = 0; headTilt = 0;
      elbows = [[45, 112], [147, 112]]; hands = [[38, 88], [154, 88]];
      knees = [[52, 150], [140, 150]]; feet = [[52, 174], [142, 174]]; face.eyes = 'wide'; face.mouth = 'o';
      fx.push({ type: 'bang', x: 156, y: 44 });
    }
  } else if (posture === 'hang') {
    sh = [96 + wave * 3, 122]; hip = [96 + wave * 5, 158];
    head = [96 + wave * 2, adult ? 83 : 85];
    elbows = [[43, 78], [149, 78]]; hands = [[43, 20], [149, 20]];
    knees = [[87 + wave * 5, 177], [104 + wave * 5, 177]];
    const toeY=D.style==='paper'?189:194; // Folded feet include a cut edge and two paper shadows.
    feet = [[84 + wave * 6, toeY], [107 + wave * 6, toeY]];
    p.arms.l.hand = p.arms.r.hand = 'grip';
    if (is('hang-peek')) {
      // A pull-up to look over the edge: elbows bend out wide, the whole body rises 12 px toward the grips.
      sh[1] -= 12; hip[1] -= 12; head = [head[0] + 12, head[1] - 13];
      elbows = [[34, 56], [158, 56]];
      for (const k of [...knees, ...feet]) k[1] -= 12;
      headTurn = 0.65; headTilt = 9; face.look = [0.8, 0.5];
    } else face.look = [0.3, -0.4];
  } else if (posture === 'climb') {
    const step = Math.sin((i + 0.5) / n * Math.PI * 2) * e;
    sh = [96 + 3 * step, 110]; hip = [96 - 4 * step, 145]; head = [96 + 4 * step, adult ? 69 : 71];
    elbows = [[48, 84 - 12 * step], [143, 84 + 12 * step]];
    hands = [[30, 43 - 20 * step], [162, 43 + 20 * step]];
    knees = [[54, 143 + 14 * step], [137, 143 - 14 * step]];
    feet = [[30, 181 + 11 * step], [163, 181 - 11 * step]];
    headTilt = -5 * step; face.look = [0.4, -0.8]; p.arms.l.hand = p.arms.r.hand = 'grip';
  } else if (posture === 'run') {
    // A long stride remains visible in the first still; the two sides alternate over the cycle.
    const stride = Math.cos(i / n * 2 * Math.PI) * e;
    sh = [105, B.shY - 3]; hip = [93, B.hipY - 4]; head = [112, B.headY - 2];
    angle = 12; headTilt = -5; headTurn = 0.45;
    knees = [[86 - 21 * stride, 165], [105 + 21 * stride, 161]];
    feet = [[82 - 40 * stride, 185 - Math.max(0, -stride) * 18], [112 + 40 * stride, 185 - Math.max(0, stride) * 18]];
    elbows = [[66 + 14 * stride, 130], [137 - 14 * stride, 124]];
    hands = [[67 + 25 * stride, 111], [137 - 25 * stride, 104]];
    face.eyes = 'focus';
    if (is('carry')) { elbows = [[61, 135], [142, 135]]; hands = [[75, 133], [133, 133]]; props.push({ type: 'box', x: 104, y: 129 }); }
  } else if (posture === 'leap') {
    const keys = [
      { sh:[99,125], hip:[94,159], head:[102,adult?89:85], el:[[61,138],[138,136]], hand:[[54,151],[144,148]], knee:[[65,173],[126,171]], foot:[[56,190],[138,190]], angle:8 },
      { sh:[105,106], hip:[89,137], head:[113,adult?70:66], el:[[54,96],[144,87]], hand:[[45,70],[154,57]], knee:[[62,160],[119,151]], foot:[[42,182],[143,172]], angle:22 },
      { sh:[104,108], hip:[84,139], head:[112,adult?68:65], el:[[52,111],[142,103]], hand:[[32,91],[163,80]], knee:[[59,146],[115,140]], foot:[[32,165],[146,159]], angle:30 },
      { sh:[109,129], hip:[94,160], head:[117,adult?91:87], el:[[62,135],[145,134]], hand:[[48,146],[159,145]], knee:[[63,173],[126,171]], foot:[[50,190],[140,190]], angle:12 },
      { sh:[96,B.shY], hip:[96,B.hipY], head:[96,B.headY], el:[[66,131],[127,131]], hand:[[66,148],[127,148]], knee:[[85,169],[106,169]], foot:[[82,187],[110,187]], angle:0 },
    ];
    const k = keys[i]; ({ sh, hip, head, angle } = k); elbows = k.el; hands = k.hand; knees = k.knee; feet = k.foot;
    face.eyes = i === 0 || i === 3 ? 'focus' : 'happy'; face.mouth = i === 2 ? 'grin' : 'smile'; headTilt = -5;
  }
  // Desk-stand reactions retain the standing proportions but make the action readable in the whole arm.
  // Each one gets its own silhouette: a weight shift, a lean toward the point, a flinch, a bow with the offered hand.
  if (!elbows) {
    const kY = (B.hipY + 187) / 2, sY = B.shY, hY = B.headY;
    elbows = [[64, sY + 18], [128, sY + 18]]; hands = [[65, sY + 39], [127, sY + 39]];
    knees = [[86, kY], [106, kY]]; feet = [[83, 187], [109, 187]];
    if (is('stand')) {
      // Contrapposto: hips over the right leg, the free leg out, one hand on the hip, the torso counter-tilted.
      hip = [100, B.hipY]; sh = [95, sY]; head = [93, hY]; angle = -4; headTilt = wave * 2 - 3;
      knees = [[80, kY + 1], [108, kY]]; feet = [[70, 189], [110, 187]];
      elbows = [[62, sY + 18], [138, sY + 20]]; hands = [[64, sY + 40], [115, B.hipY - 3]]; p.arms.r.hand = 'fist';
      face.eyes = i === 1 ? 'closed' : i === 2 ? 'half' : 'open';
    }
    if (is('point')) {
      const k = [2, 5, 6][i];
      sh = [96 + k * 0.6, sY]; head = [96 + k * 1.3, hY]; angle = k; feet = [[83, 187], [113, 187]]; knees = [[86, kY], [108, kY]];
      elbows[1] = [[135, sY + 7], [143, sY - 9], [143, sY - 13]][i]; hands[1] = [[145, sY - 8], [162, sY - 24], [167, sY - 28]][i];
      p.arms.r.hand = 'point'; headTurn = 0.5; face.look = [0.9, -0.1];
    }
    if (is('wince')) {
      // A flinch: torso hunched, knees knocked together, fists up and wide of the head, elbows out.
      sh = [96, sY + 6]; hip = [96, B.hipY + 2]; head = [96, hY + 7]; headTilt = [-11, 11, -8, 0][i];
      elbows = [[38, sY + 8], [154, sY + 8]]; hands = [[46, hY + 10], [146, hY + 10]]; p.arms.l.hand = p.arms.r.hand = 'fist';
      knees = [[90, kY + 2], [102, kY + 2]]; feet = [[78, 189], [114, 189]];
      face.eyes = i < 3 ? 'squeeze' : 'open'; face.mouth = 'wobble'; fx.push({type:'sweat',at:'head',side:'r'});
    }
    if (is('handoff')) {
      // Offering the pointer back: a small bow toward the open palm, the other hand on the hip.
      const bow = [3, 6, 8, 0][i];
      sh = [96 - bow * 0.5, sY]; head = [96 - bow * 1.4, hY + bow * 0.4]; angle = -bow; headTilt = -bow * 0.6;
      elbows[0] = [56, sY + 14]; hands[0] = [[38, sY + 16], [28, sY + 10], [22, sY + 6], [54, sY + 22]][i]; p.arms.l.hand = 'palm';
      elbows[1] = [136, sY + 20]; hands[1] = [116, B.hipY - 3]; p.arms.r.hand = 'fist';
      feet = [[78, 188], [112, 187]]; knees = [[84, kY], [108, kY]];
      headTurn = -0.3; face.eyes = 'happy';
    }
  }
  // Torso affine map, preserving the character's original jacket, coat, fur or folded box.
  const dy = B.hipY - B.shY, a = Math.cos(angle * Math.PI / 180), b = Math.sin(angle * Math.PI / 180);
  const c = (hip[0] - sh[0]) / dy, d = (hip[1] - sh[1]) / dy;
  const tx = sh[0] - a * 96 - c * B.shY, ty = sh[1] - b * 96 - d * B.shY;
  const map = ([x,y]) => [a*x+c*y+tx,b*x+d*y+ty];
  const arms = {}, legs = {};
  for (const [j, s] of ['l','r'].entries()) {
    const sg = j ? 1 : -1, shoulder = map([96+sg*B.shoulder,B.shY]);
    const hc = hands[j], d2 = unit([hc[0]-elbows[j][0],hc[1]-elbows[j][1]]), wr = [hc[0]-d2[0]*5.2,hc[1]-d2[1]*5.2];
    const hand = p.arms[s].hand;
    arms[s] = { ...p.arms[s], s, sg, sh:shoulder, el:elbows[j], wr, hc, d2, d1:unit([elbows[j][0]-shoulder[0],elbows[j][1]-shoulder[1]]),
      tip:[hc[0]+d2[0]*(hand==='point'?13.5:7),hc[1]+d2[1]*(hand==='point'?13.5:7)], front:true, limb:B.limb };
    legs[s] = { hip:map([96+sg*B.hipW,B.hipY]), knee:knees[j], foot:feet[j], toe:posture==='hang'||posture==='sit' ? 65 : posture==='lie'&&!is('sleep') ? -65 : 0 };
  }
  if (fox && posture === 'lie') tilt = 0; // The head stays upright; the tail follows the torso.
  p.face = face; p.head.tilt = headTilt + tilt; p.head.turn = headTurn;
  const anchor = at => at==='head'?head:at==='hands'?mid(hands[0],hands[1]):at==='chest'?mid(sh,hip):at==='overhead'?[head[0],head[1]-45*B.head]:arms[at.split('.')[1]]?.[at.startsWith('tip')?'tip':'hc']??hip;
  // In the three-quarter seat the viewer-left leg is nearer, so it is drawn last.
  const legOrder = posture === 'sit' && !is('startle') ? ['r', 'l'] : ['l', 'r'];
  return { width:posture==='lie'?320:192, sh, hip, head, arms, legs, legOrder, anchor, map, props, fx,
    torso:`matrix(${[a,b,c,d,tx,ty].map(f).join(' ')})`,
    edge:posture==='lie'?[160,150]:posture==='hang'?[96,20]:posture==='sit'?[96,142]:[96,196] };
}

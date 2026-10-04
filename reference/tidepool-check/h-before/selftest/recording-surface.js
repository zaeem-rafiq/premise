// A surface that draws nothing and counts what it was asked to draw. The self-test uses it in place of a canvas.
export function createRecordingSurface() {
  const calls = { reset: 0, push: 0, pop: 0, style: 0, shapes: 0, turn: 0, flip: 0 };
  const shape = () => {
    calls.shapes += 1;
  };
  return {
    calls,
    reset() {
      calls.reset += 1;
    },
    push() {
      calls.push += 1;
    },
    pop() {
      calls.pop += 1;
    },
    style() {
      calls.style += 1;
    },
    turn() {
      calls.turn += 1;
    },
    flip() {
      calls.flip += 1;
    },
    circle: shape,
    ellipse: shape,
    rect: shape,
    line: shape,
    poly: shape,
    arc: shape,
  };
}

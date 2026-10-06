/**
 * Keeps valleys open when a heightmap is coarsened. Averaging a gorge that is
 * narrower than a cell with its walls dams the valley behind it, which later
 * floods as a false lake; hydrology tools condition at native resolution
 * before resampling for this reason.
 */

/** D8 neighbour offsets; direction d and (d + 4) % 8 are opposite. */
const D8_X = [0, 1, 1, 1, 0, -1, -1, -1];
const D8_Y = [-1, -1, 0, 1, 1, 1, 0, -1];

/**
 * Lowers cells of a coarsened heightmap just enough for water to follow the
 * valleys that `floor` (the lowest source sample under each cell) shows, and
 * never below that floor. A barrier that is real in the source keeps its
 * floor, so genuine closed basins stay closed. Sea cells are NaN in `values`.
 */
export function openDrainageToFloor(values: Float32Array, floor: Float32Array, width: number, height: number): void {
  const total = width * height;
  // Priority-flood on the floor from the sea and the map edge. Each cell's
  // receiver is the cell that reached it, so receivers lead to an outlet.
  const receiver = new Int8Array(total).fill(-2);
  const order = new Int32Array(total);
  const heapCells = new Int32Array(total);
  const heapKeys = new Float32Array(total);
  let heapSize = 0;
  let ordered = 0;
  const push = (cell: number, key: number) => {
    let position = heapSize++;
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (heapKeys[parent] <= key) break;
      heapCells[position] = heapCells[parent];
      heapKeys[position] = heapKeys[parent];
      position = parent;
    }
    heapCells[position] = cell;
    heapKeys[position] = key;
  };
  const pop = () => {
    const cell = heapCells[0];
    const key = heapKeys[0];
    const lastCell = heapCells[--heapSize];
    const lastKey = heapKeys[heapSize];
    let position = 0;
    for (;;) {
      let child = position * 2 + 1;
      if (child >= heapSize) break;
      if (child + 1 < heapSize && heapKeys[child + 1] < heapKeys[child]) child++;
      if (heapKeys[child] >= lastKey) break;
      heapCells[position] = heapCells[child];
      heapKeys[position] = heapKeys[child];
      position = child;
    }
    heapCells[position] = lastCell;
    heapKeys[position] = lastKey;
    return { cell, key };
  };
  const levelOf = (cell: number, inflow: number) =>
    Number.isNaN(values[cell]) ? Number.NEGATIVE_INFINITY : Math.max(floor[cell], inflow);

  for (let cell = 0; cell < total; cell++) {
    const x = cell % width;
    const y = (cell - x) / width;
    if (Number.isNaN(values[cell]) || x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      receiver[cell] = -1;
      push(cell, levelOf(cell, Number.NEGATIVE_INFINITY));
    }
  }
  while (heapSize > 0) {
    const { cell, key } = pop();
    order[ordered++] = cell;
    const x = cell % width;
    const y = (cell - x) / width;
    for (let direction = 0; direction < 8; direction++) {
      const nx = x + D8_X[direction];
      const ny = y + D8_Y[direction];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = ny * width + nx;
      if (receiver[neighbour] !== -2) continue;
      receiver[neighbour] = (direction + 4) % 8;
      push(neighbour, levelOf(neighbour, key));
    }
  }

  // Upstream cells first: a receiver may sit no higher than any cell that
  // drains into it, unless its own floor is higher.
  for (let k = ordered - 1; k >= 0; k--) {
    const cell = order[k];
    const direction = receiver[cell];
    if (direction < 0 || Number.isNaN(values[cell])) continue;
    const target = cell + D8_Y[direction] * width + D8_X[direction];
    if (Number.isNaN(values[target])) continue;
    const opened = Math.max(floor[target], values[cell]);
    if (opened < values[target]) values[target] = opened;
  }
}

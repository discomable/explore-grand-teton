/* Pure dense-range contract for GroundCover submission buffers.
 *
 * Cells append atomically to one dense instance prefix. Removing a cell moves the
 * last cell into its range and shifts the intervening cells as one bounded range.
 * The result stays dense while each cell continues to own one contiguous range.
 */
export class DenseGroundCoverSubmission {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 0)
      throw new RangeError('capacity must be a non-negative integer');
    this.capacity = capacity;
    this.live = 0;
    this.cells = new Map();
    this.order = [];
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.dirtyRangeCount = 0;
    this.uploadBytes = 0;
    this.relocations = 0;
    this.turnoverCells = 0;
    this.turnoverInstances = 0;
  }

  available() { return this.capacity - this.live; }

  markDirty(lo, hi) {
    if (hi < lo) return;
    if (lo < this.dirtyLo) this.dirtyLo = lo;
    if (hi > this.dirtyHi) this.dirtyHi = hi;
  }

  insert(key, count) {
    if (this.cells.has(key)) throw new Error(`duplicate ground-cover cell: ${key}`);
    if (!Number.isInteger(count) || count < 0 || count > this.available())
      throw new RangeError('ground-cover cell exceeds dense submission capacity');
    const cell = { start: this.live, used: count };
    this.cells.set(key, cell);
    this.order.push(key);
    this.live += count;
    this.turnoverCells++;
    this.turnoverInstances += count;
    this.markDirty(cell.start, cell.start + count - 1);
    return cell;
  }

  remove(key, buffers = []) {
    const removed = this.cells.get(key);
    if (!removed) return null;
    const oldLive = this.live;
    const index = this.order.indexOf(key);
    const lastKey = this.order[this.order.length - 1];
    const last = this.cells.get(lastKey);
    let relocated = 0;

    if (key !== lastKey) {
      const middleStart = removed.start + removed.used;
      const middleEnd = last.start;
      for (const { array, itemSize } of buffers) {
        const tail = array.slice(last.start * itemSize, oldLive * itemSize);
        array.copyWithin(
          (removed.start + last.used) * itemSize,
          middleStart * itemSize,
          middleEnd * itemSize);
        array.set(tail, removed.start * itemSize);
      }
      last.start = removed.start;
      for (let i = index + 1; i < this.order.length - 1; i++) {
        const cell = this.cells.get(this.order[i]);
        cell.start += last.used - removed.used;
      }
      this.order.pop();
      this.order[index] = lastKey;
      relocated = oldLive - removed.start - removed.used;
    } else {
      this.order.pop();
    }

    this.cells.delete(key);
    this.live -= removed.used;
    this.relocations += relocated;
    this.turnoverCells++;
    this.turnoverInstances += removed.used;
    if (key !== lastKey) this.markDirty(removed.start, this.live - 1);
    return {
      start: removed.start,
      previousEnd: oldLive,
      removed: removed.used,
      relocated,
    };
  }

  takeUploadPlan(bytesPerInstance) {
    if (this.dirtyHi < 0) return null;
    if (!Number.isFinite(bytesPerInstance) || bytesPerInstance < 0)
      throw new RangeError('bytesPerInstance must be non-negative');
    const plan = {
      start: this.dirtyLo,
      count: this.dirtyHi - this.dirtyLo + 1,
    };
    plan.bytes = plan.count * bytesPerInstance;
    this.dirtyRangeCount++;
    this.uploadBytes += plan.bytes;
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    return plan;
  }

  telemetry(submittedInstances = this.live) {
    return {
      submittedInstances,
      liveInstances: this.live,
      capacityInstances: this.capacity,
      dirtyRangeCount: this.dirtyRangeCount,
      uploadBytes: this.uploadBytes,
      relocations: this.relocations,
      turnoverCells: this.turnoverCells,
      turnoverInstances: this.turnoverInstances,
    };
  }
}

export function normalizedCellRecords(submission, buffers) {
  const records = [];
  for (const [key, cell] of submission.cells) {
    for (let i = 0; i < cell.used; i++) {
      const record = { key, index: i };
      for (const [name, { array, itemSize }] of Object.entries(buffers)) {
        const begin = (cell.start + i) * itemSize;
        record[name] = Array.from(array.subarray(begin, begin + itemSize));
      }
      records.push(record);
    }
  }
  return records.sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index);
}

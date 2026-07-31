import test from 'node:test';
import assert from 'node:assert/strict';

class MockWorker {
  static instances = [];
  static mode = 'auto';
  constructor() {
    this.mode = MockWorker.mode;
    MockWorker.instances.push(this);
  }
  postMessage(message, transfer = []) {
    this.sent ||= [];
    this.sent.push({ message, transfer });
    this.last = { message, transfer };
    if (message.kind === 'cancel') return;
    if (this.mode === 'manual') return;
    queueMicrotask(() => this.onmessage?.({
      data: { id: message.id, generation: message.generation, ok: true, meta: {}, buffers: [] },
    }));
  }
  terminate() { this.terminated = true; }
  reply(data = {}) {
    const request = this.last.message;
    this.onmessage?.({ data: {
      id: request.id, generation: request.generation, ok: true, meta: {}, buffers: [], ...data,
    } });
  }
  crash(message = 'boom') {
    this.onerror?.({ error: new Error(message), message });
  }
}

globalThis.Worker = MockWorker;
const { WorkerPool } = await import('../terrain/src/workers/WorkerPool.js?test');

test.beforeEach(() => {
  MockWorker.instances.length = 0;
  MockWorker.mode = 'auto';
});

test('uses the bounded hardware-concurrency pool size', () => {
  const pool = new WorkerPool({ size: 2, url: 'mock.js' });
  assert.equal(pool.workers.length, 2);
  pool.destroy();
});

test('preserves protocol fields and transfer lists', async () => {
  const pool = new WorkerPool({ size: 1, url: 'mock.js' });
  const buffer = new ArrayBuffer(8);
  const result = await pool.run('scatterMatrices', { points: buffer }, {
    generation: 7, priority: 12, scope: 'scatter', transfer: [buffer],
  });
  const sent = pool.workers[0].worker.last;
  assert.equal(sent.message.kind, 'scatterMatrices');
  assert.equal(sent.message.generation, 7);
  assert.equal(sent.message.priority, 12);
  assert.deepEqual(sent.transfer, [buffer]);
  assert.equal(result.generation, 7);
  pool.destroy();
});

test('rejects queued work when its generation is superseded', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, url: 'mock.js' });
  const pending = pool.run('scatterMatrices', {}, { generation: 1, scope: 'terrain' });
  pool.supersede('terrain', 2);
  await assert.rejects(pending, error => error.name === 'AbortError');
  pool.destroy();
});

test('reports queue telemetry and enforces the queue bound', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, maxQueue: 1, url: 'mock.js' });
  const running = pool.run('scatterMatrices', {}, { generation: 1 });
  const queued = pool.run('scatterMatrices', {}, { generation: 1 });
  await assert.rejects(pool.run('scatterMatrices', {}, { generation: 1 }), /queue limit/);
  assert.deepEqual(
    { running: pool.snapshot().running, queued: pool.snapshot().queued },
    { running: 1, queued: 1 },
  );
  const runningRejected = assert.rejects(running, error => error.name === 'AbortError');
  const queuedRejected = assert.rejects(queued, error => error.name === 'AbortError');
  pool.cancel(1);
  pool.cancel(2);
  await runningRejected;
  await queuedRejected;
  pool.destroy();
});

test('orders queued jobs by priority and submission order', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, url: 'mock.js' });
  const first = pool.run('first', {});
  const low = pool.run('low', {}, { priority: 1 });
  const highA = pool.run('high-a', {}, { priority: 10 });
  const highB = pool.run('high-b', {}, { priority: 10 });
  const worker = pool.workers[0].worker;
  worker.reply();
  assert.equal(worker.last.message.kind, 'high-a');
  worker.reply();
  assert.equal(worker.last.message.kind, 'high-b');
  worker.reply();
  assert.equal(worker.last.message.kind, 'low');
  worker.reply();
  await Promise.all([first, low, highA, highB]);
  pool.destroy();
});

test('removes a cancelled queued job without sending it', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, url: 'mock.js' });
  const running = pool.run('running', {});
  const queued = pool.run('never-send', {});
  const rejected = assert.rejects(queued, error => error.name === 'AbortError');
  assert.equal(pool.cancel(2, 'not visible'), true);
  await rejected;
  const worker = pool.workers[0].worker;
  worker.reply();
  await running;
  assert.deepEqual(worker.sent.map(item => item.message.kind), ['running']);
  assert.equal(pool.snapshot().cancelled, 1);
  pool.destroy();
});

test('rejects a reply made stale by a newer generation', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, url: 'mock.js' });
  const pending = pool.run('terrain', {}, { scope: 'terrain', generation: 4 });
  pool.generations.set('terrain', 5);
  pool.workers[0].worker.reply();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(pool.snapshot().completed, 0);
  pool.destroy();
});

test('restarts a crashed worker and retries an untransferred job once', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, url: 'mock.js' });
  const pending = pool.run('retryable', { value: 1 });
  const crashed = pool.workers[0].worker;
  crashed.crash('worker died');
  assert.equal(crashed.terminated, true);
  const replacement = pool.workers[0].worker;
  assert.notEqual(replacement, crashed);
  assert.equal(replacement.last.message.kind, 'retryable');
  replacement.reply();
  await pending;
  assert.deepEqual(
    { crashed: pool.snapshot().crashed, retried: pool.snapshot().retried, failed: pool.snapshot().failed },
    { crashed: 1, retried: 1, failed: 0 },
  );
  pool.destroy();
});

test('does not retry a job whose transferable payload may be detached', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, url: 'mock.js' });
  const buffer = new ArrayBuffer(16);
  const pending = pool.run('decode', { buffer }, { transfer: [buffer] });
  const rejected = assert.rejects(pending, /cannot retry transferred payload/);
  pool.workers[0].worker.crash('decoder crashed');
  await rejected;
  assert.equal(MockWorker.instances.length, 2);
  assert.equal(pool.workers[0].worker.last, undefined);
  assert.deepEqual(
    { failed: pool.snapshot().failed, transferCrashFailures: pool.snapshot().transferCrashFailures },
    { failed: 1, transferCrashFailures: 1 },
  );
  pool.destroy();
});

test('rejects after the crash retry limit and reports telemetry', async () => {
  MockWorker.mode = 'manual';
  const pool = new WorkerPool({ size: 1, maxCrashRetries: 1, url: 'mock.js' });
  const pending = pool.run('fragile', {});
  pool.workers[0].worker.crash('first');
  const rejected = assert.rejects(pending, /retry limit reached/);
  pool.workers[0].worker.crash('second');
  await rejected;
  const stats = pool.snapshot();
  assert.equal(stats.crashed, 2);
  assert.equal(stats.retried, 1);
  assert.equal(stats.failed, 1);
  pool.destroy();
});

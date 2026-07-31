const DEFAULT_SIZE = Math.min(4, Math.max(1, (globalThis.navigator?.hardwareConcurrency || 2) - 2));

export class WorkerPool {
  static supported = typeof Worker !== 'undefined';

  constructor({
    size = DEFAULT_SIZE,
    maxQueue = 512,
    maxCrashRetries = 1,
    url = new URL('./cpu-worker.js', import.meta.url),
  } = {}) {
    if (!WorkerPool.supported) throw new Error('Module workers are not supported');
    this.url = url;
    this.workers = [];
    this.queue = [];
    this.jobs = new Map();
    this.generations = new Map();
    this.nextId = 1;
    this.maxQueue = maxQueue;
    this.maxCrashRetries = maxCrashRetries;
    this.stats = {
      submitted: 0, completed: 0, cancelled: 0, failed: 0,
      crashed: 0, retried: 0, transferCrashFailures: 0, totalMs: 0,
    };
    for (let i = 0; i < size; i++) this._spawn(i);
  }

  run(kind, payload, { generation = 0, priority = 0, scope = 'global', transfer = [] } = {}) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new Error(`Worker queue limit (${this.maxQueue}) reached`));
    }
    const id = this.nextId++;
    this.stats.submitted++;
    const current = this.generations.get(scope) ?? generation;
    this.generations.set(scope, Math.max(current, generation));
    return new Promise((resolve, reject) => {
      const job = {
        id, kind, generation, priority, scope, payload, transfer, resolve, reject,
        state: 'queued', submittedAt: performance.now(), crashRetries: 0,
      };
      this.jobs.set(id, job);
      this.queue.push(job);
      this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
      this._drain();
    });
  }

  cancel(id, reason = 'cancelled') {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.stats.cancelled++;
    if (job.state === 'running') job.slot.worker.postMessage({ id, kind: 'cancel' });
    this._finish(job, new DOMException(reason, 'AbortError'));
    this._drain();
    return true;
  }

  supersede(scope, generation) {
    this.generations.set(scope, generation);
    for (const job of [...this.jobs.values()]) {
      if (job.scope === scope && job.generation < generation) this.cancel(job.id, 'stale generation');
    }
  }

  destroy() {
    for (const job of [...this.jobs.values()]) this._finish(job, new Error('Worker pool destroyed'));
    for (const slot of this.workers) slot.worker.terminate();
    this.workers.length = 0;
  }

  snapshot() {
    const running = this.workers.reduce((sum, slot) => sum + (slot.job ? 1 : 0), 0);
    return {
      ...this.stats,
      size: this.workers.length,
      queued: this.queue.length,
      running,
      averageMs: this.stats.completed ? this.stats.totalMs / this.stats.completed : 0,
    };
  }

  _spawn(index) {
    const worker = new Worker(this.url, { type: 'module', name: `teton-cpu-${index}` });
    const slot = { worker, job: null, index };
    worker.onmessage = event => this._message(slot, event.data);
    worker.onerror = event => this._crash(slot, event.error || new Error(event.message));
    this.workers[index] = slot;
  }

  _drain() {
    for (const slot of this.workers) {
      if (slot.job) continue;
      const job = this.queue.shift();
      if (!job) break;
      if (!this.jobs.has(job.id)) continue;
      job.state = 'running'; job.slot = slot; slot.job = job;
      try {
        slot.worker.postMessage({
          id: job.id, kind: job.kind, generation: job.generation,
          priority: job.priority, payload: job.payload,
        }, job.transfer);
      } catch (error) {
        this._crash(slot, error);
      }
    }
  }

  _message(slot, message) {
    const job = slot.job;
    if (!job || message.id !== job.id) return;
    slot.job = null;
    const current = this.generations.get(job.scope) ?? job.generation;
    if (message.generation !== job.generation || job.generation < current) {
      this._finish(job, new DOMException('stale generation', 'AbortError'));
    } else if (message.ok) {
      this.stats.completed++;
      this.stats.totalMs += performance.now() - job.submittedAt;
      this._finish(job, null, message);
    } else {
      this.stats.failed++;
      this._finish(job, new Error(`[${job.kind} #${job.id}] ${message.error}`));
    }
    this._drain();
  }

  _crash(slot, error) {
    this.stats.crashed++;
    const job = slot.job;
    slot.worker.terminate();
    slot.job = null;
    if (job && this.jobs.has(job.id)) {
      job.slot = null;
      // Once postMessage has accepted a transfer list, its buffers are detached
      // from this realm. Retrying that payload would silently submit empty data.
      if (job.transfer.length) {
        this.stats.failed++;
        this.stats.transferCrashFailures++;
        this._finish(job, this._jobCrashError(job, error, 'cannot retry transferred payload'));
      } else if (job.crashRetries < this.maxCrashRetries) {
        job.crashRetries++;
        job.state = 'queued';
        this.stats.retried++;
        this.queue.push(job);
        this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
      } else {
        this.stats.failed++;
        this._finish(job, this._jobCrashError(job, error, 'retry limit reached'));
      }
    }
    this._spawn(slot.index);
    console.warn(`[workers] worker ${slot.index} restarted`, error);
    this._drain();
  }

  _jobCrashError(job, error, reason) {
    const detail = error?.message || String(error || 'unknown worker error');
    return new Error(`[${job.kind} #${job.id}] worker crashed (${reason}): ${detail}`);
  }

  _finish(job, error, value) {
    this.jobs.delete(job.id);
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (job.slot?.job === job) job.slot.job = null;
    error ? job.reject(error) : job.resolve(value);
  }
}

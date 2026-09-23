const operationError = (code, message) =>
  Object.assign(new Error(message), { code, statusCode: 409 });

const superseded = () => operationError("superseded", "A newer Gmail watch request replaced this operation.");

// One running command and one latest pending intent per account. New intents
// invalidate the running token immediately; its cleanup still owns the lane
// until it settles. Repeated clicks never build an unbounded command queue.
const createGmailAccountOperations = ({ onIdle = () => {} } = {}) => {
  const lanes = new Map();
  let stopped = false;

  const laneFor = (accountId) => {
    if (!lanes.has(accountId)) lanes.set(accountId, { generation: 0, active: null, pending: null });
    return lanes.get(accountId);
  };
  const isDisconnecting = (accountId) => {
    const lane = lanes.get(accountId);
    return lane?.active?.kind === "disconnect" || lane?.pending?.kind === "disconnect";
  };
  const isBusy = (accountId) => Boolean(lanes.get(accountId)?.active || lanes.get(accountId)?.pending);

  const activate = (accountId, lane, operation) => {
    lane.active = operation;
    const current = () => !stopped && lane.generation === operation.generation;
    const context = { isCurrent: current, assertCurrent: () => { if (!current()) throw superseded(); } };
    let work;
    try { work = operation.run(context, operation.prepared); }
    catch (error) { work = Promise.reject(error); }
    Promise.resolve(work).then(
      (value) => current() ? operation.resolve(value) : operation.reject(superseded()),
      (error) => operation.reject(error),
    ).finally(() => {
      if (lane.active !== operation) return;
      lane.active = null;
      const next = lane.pending;
      lane.pending = null;
      if (next && !stopped) activate(accountId, lane, next);
      else {
        if (next) next.reject(superseded());
        lanes.delete(accountId);
        onIdle(accountId);
      }
    }).catch(() => {});
  };

  const request = ({ accountId, kind, key = kind, conditional = false, prepare = () => {}, run }) => {
    if (stopped) return Promise.reject(operationError("service_stopping", "Gmail watch services are stopping."));
    const lane = laneFor(accountId);
    if (isDisconnecting(accountId)) {
      if (kind === "disconnect") return (lane.pending?.kind === kind ? lane.pending : lane.active).promise;
      return Promise.reject(operationError("account_disconnecting", "This Google account is being disconnected."));
    }
    if (lane.pending?.key === key) return lane.pending.promise;
    if (!lane.pending && lane.active?.key === key && lane.active.generation === lane.generation) return lane.active.promise;
    if (conditional && (lane.active || lane.pending)) return Promise.reject(superseded());

    let prepared;
    try { prepared = prepare(); }
    catch (error) {
      if (!lane.active && !lane.pending) { lanes.delete(accountId); onIdle(accountId); }
      return Promise.reject(error);
    }
    const operation = { kind, key, run, prepared, generation: ++lane.generation };
    operation.promise = new Promise((resolve, reject) => { operation.resolve = resolve; operation.reject = reject; });
    // Callers may attach their handlers after a burst of clicks. Mark the
    // promise handled internally while preserving rejection for every caller.
    operation.promise.catch(() => {});
    if (lane.pending) lane.pending.reject(superseded());
    if (lane.active) lane.pending = operation;
    else activate(accountId, lane, operation);
    return operation.promise;
  };

  const stop = async () => {
    stopped = true;
    const active = [];
    for (const lane of lanes.values()) {
      lane.generation += 1;
      if (lane.pending) lane.pending.reject(superseded());
      lane.pending = null;
      if (lane.active) active.push(lane.active.promise);
    }
    await Promise.allSettled(active);
  };

  return { request, isBusy, isDisconnecting, stop, start: () => { stopped = false; } };
};

module.exports = { createGmailAccountOperations, operationError };

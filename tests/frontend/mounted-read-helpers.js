import { h, render } from "preact";
import { act } from "preact/test-utils";

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// The probes render no DOM. Preact still mounts real components and runs its
// real hook/effect/unmount scheduler; the host only needs an empty root node
// and visibility events. This keeps these lifecycle tests hermetic in Node.
export const createReadHost = () => {
  const listeners = new Set();
  const document = {
    hidden: false,
    addEventListener: (name, listener) => { if (name === "visibilitychange") listeners.add(listener); },
    removeEventListener: (name, listener) => { if (name === "visibilitychange") listeners.delete(listener); },
  };
  const root = { nodeType: 1, childNodes: [], ownerDocument: document };
  const results = new Map();
  function Probe({ id, useRead, args }) {
    results.set(id, useRead(...args));
    return null;
  }
  return {
    document,
    result: (id) => results.get(id),
    render: async (probes) => {
      await act(() => render(probes.map(({ id, useRead, args }) => h(Probe, { key: id, id, useRead, args })), root));
    },
    settle: async (work = () => {}) => {
      await act(async () => {
        await work();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
    },
    hidden: async (hidden) => {
      await act(() => {
        document.hidden = hidden;
        for (const listener of listeners) listener();
      });
    },
    unmount: async () => { await act(() => render(null, root)); },
    listenerCount: () => listeners.size,
  };
};

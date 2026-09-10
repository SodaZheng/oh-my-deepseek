import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderMacLoadingOverlayBody } from "../src/templates/macos-loading.mjs";

function harness({ root = null, main = null } = {}) {
  const frames = [];
  const timers = [];
  const requests = [];
  const classes = new Set();
  let mutate;
  const overlay = { classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name) }, remove() {} };
  const document = {
    documentElement: {},
    getElementById: (id) => id === "root" ? root : id === "omd-launch" ? overlay : null,
    querySelector: () => main,
  };
  const source = renderMacLoadingOverlayBody().match(/<script id="omd-launch-handoff">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(source, {
    document, URL, location: { href: "http://localhost/?__omd_launch=1" }, history: { replaceState() {} },
    getComputedStyle: (element) => ({ visibility: element.visibility || "visible" }),
    fetch: async (url) => { requests.push(url); },
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback, ms) => timers.push({ callback, ms }),
    setInterval() { return 1; }, clearInterval() {},
    MutationObserver: class { constructor(callback) { mutate = callback; } observe() {} disconnect() {} },
  });
  return { requests, timers, mutate: () => mutate(), frame: () => frames.shift()?.() };
}

const content = () => ({ childElementCount: 1, getBoundingClientRect: () => ({ height: 300 }) });

test("a rendered login page without a React root is revealed after two actual frames", () => {
  const page = harness({ main: content() });
  page.mutate(); page.mutate();
  assert.equal(page.requests.length, 0);
  page.frame(); page.mutate();
  assert.equal(page.requests.length, 0);
  page.frame();
  assert.deepEqual(page.requests, ["/__omd_handoff_complete?reason=rendered"]);
});

test("a React shell waits for real content even when another form exists", () => {
  const root = content(); root.childElementCount = 0;
  const page = harness({ root, main: content() });
  page.frame(); page.frame();
  assert.equal(page.requests.length, 0);
  root.childElementCount = 1;
  page.frame(); page.frame();
  assert.equal(page.requests.length, 1);
});

test("hidden pages stay covered and the fallback reports a timeout", () => {
  const main = content(); main.visibility = "hidden";
  const page = harness({ main });
  page.frame(); page.frame();
  assert.equal(page.requests.length, 0);
  page.timers.find((timer) => timer.ms === 15000).callback();
  assert.deepEqual(page.requests, ["/__omd_handoff_complete?reason=timeout"]);
});

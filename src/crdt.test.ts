import { describe, it, expect } from "vitest";
import { LWWRegister, compareHLC, incrementHLC, type HLC } from "./crdt.js";

describe("compareHLC", () => {
  it("orders by wallClock first", () => {
    const a: HLC = { wallClock: 100, logical: 0, nodeId: "n1" };
    const b: HLC = { wallClock: 200, logical: 0, nodeId: "n1" };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it("uses logical counter as tiebreaker", () => {
    const a: HLC = { wallClock: 100, logical: 1, nodeId: "n1" };
    const b: HLC = { wallClock: 100, logical: 2, nodeId: "n1" };
    expect(compareHLC(a, b)).toBeLessThan(0);
  });

  it("uses nodeId as final tiebreaker", () => {
    const a: HLC = { wallClock: 100, logical: 0, nodeId: "a" };
    const b: HLC = { wallClock: 100, logical: 0, nodeId: "b" };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for equal timestamps", () => {
    const a: HLC = { wallClock: 100, logical: 5, nodeId: "n1" };
    expect(compareHLC(a, { ...a })).toBe(0);
  });
});

describe("incrementHLC", () => {
  it("advances wallClock when physical time has moved forward", () => {
    const old: HLC = { wallClock: 0, logical: 42, nodeId: "n1" };
    const next = incrementHLC(old);
    expect(next.wallClock).toBeGreaterThan(0);
    expect(next.logical).toBe(0);
    expect(next.nodeId).toBe("n1");
  });

  it("increments logical counter when wallClock has not advanced", () => {
    const future: HLC = {
      wallClock: Date.now() + 100_000,
      logical: 5,
      nodeId: "n1",
    };
    const next = incrementHLC(future);
    expect(next.wallClock).toBe(future.wallClock);
    expect(next.logical).toBe(6);
  });
});

describe("LWWRegister", () => {
  it("starts undefined", () => {
    const reg = new LWWRegister<string>("n1");
    expect(reg.get()).toBeUndefined();
  });

  it("set() stores a value", () => {
    const reg = new LWWRegister<string>("n1");
    reg.set("hello");
    expect(reg.get()).toBe("hello");
  });

  it("set() advances the HLC", () => {
    const reg = new LWWRegister<number>("n1");
    const before = reg.timestamp;
    reg.set(42);
    expect(compareHLC(reg.timestamp, before)).toBeGreaterThan(0);
  });

  it("merge() picks remote when it has a higher HLC", () => {
    const reg = new LWWRegister<string>("n1");
    reg.set("local");

    const remoteTs: HLC = {
      wallClock: Date.now() + 100_000,
      logical: 0,
      nodeId: "n2",
    };
    const result = reg.merge({ value: "remote", timestamp: remoteTs });
    expect(result.chosen).toBe("remote");
    expect(reg.get()).toBe("remote");
  });

  it("merge() keeps local when it has a higher HLC", () => {
    const reg = new LWWRegister<string>("n1");
    reg.set("local");

    const oldTs: HLC = { wallClock: 0, logical: 0, nodeId: "n2" };
    const result = reg.merge({ value: "remote", timestamp: oldTs });
    expect(result.chosen).toBe("local");
    expect(reg.get()).toBe("local");
  });

  it("merge() is commutative — same result regardless of order", () => {
    const regA = new LWWRegister<string>("n1");
    const regB = new LWWRegister<string>("n2");

    const tsA: HLC = { wallClock: 100, logical: 0, nodeId: "n1" };
    const tsB: HLC = { wallClock: 200, logical: 0, nodeId: "n2" };

    // Merge A into B
    regA.set("A");
    regB.set("B");
    const regAB = new LWWRegister<string>("observer");
    regAB.merge({ value: "A", timestamp: tsA });
    regAB.merge({ value: "B", timestamp: tsB });

    // Merge B into A (reverse order)
    const regBA = new LWWRegister<string>("observer");
    regBA.merge({ value: "B", timestamp: tsB });
    regBA.merge({ value: "A", timestamp: tsA });

    expect(regAB.get()).toBe(regBA.get());
  });
});

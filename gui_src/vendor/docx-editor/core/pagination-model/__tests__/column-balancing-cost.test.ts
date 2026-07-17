import { describe, expect, test } from 'bun:test';
import { createSegmentCostIndex, partitionUnits, type BalanceUnit } from '../columnBalancing';

describe('continuous-section balancing costs', () => {
  test('indexes segment heights with linear storage', () => {
    const unitCount = 160;
    const units: BalanceUnit[] = Array.from({ length: unitCount }, (_, blockIndex) => ({
      height: 1,
      blockIndex,
      startsBlock: true,
    }));

    const costs = createSegmentCostIndex(units, 0);

    expect(costs.storageEntries).toBeLessThanOrEqual(5 * unitCount + 3);
    expect(costs.height(0, unitCount)).toBe(unitCount);
    expect(costs.height(40, 120)).toBe(80);
  });

  test('partitioning performs bounded quadratic unit access', () => {
    const unitCount = 120;
    const columnCount = 4;
    let indexedReads = 0;
    const source: BalanceUnit[] = Array.from({ length: unitCount }, (_, blockIndex) => ({
      height: 1,
      blockIndex,
      startsBlock: true,
    }));
    const units = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads++;
        return Reflect.get(target, property, receiver);
      },
    });

    const plan = partitionUnits(units, columnCount, unitCount, 0);

    expect(plan?.height).toBe(30);
    expect(indexedReads).toBeLessThan((columnCount + 2) * unitCount * unitCount);
  });
});

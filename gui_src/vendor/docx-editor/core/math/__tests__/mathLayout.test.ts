/**
 * End-to-end through the layout side of the pipeline: a `math` node in the
 * document model has to arrive at the painter as a measurable box carrying the
 * MathML, not as the flattened plain text the editor used to show.
 */

import { describe, expect, it } from 'vitest';
import { schema } from '../../prosemirror/schema';
import { buildBoxTree } from '../../flow-model/buildBoxTree';
import { paragraphLayout } from '../../flow-model/metrics/paragraphLayout';
import type { MathRun, ParagraphBlock } from '../../pagination-model/types';

const OMML =
  '<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e>' +
  '<m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>';

function paragraphWithEquation(attrs: Record<string, unknown> = {}): ParagraphBlock {
  const math = schema.node('math', {
    display: 'inline',
    ommlXml: OMML,
    plainText: 'x2',
    ...attrs,
  });
  const paragraph = schema.node('paragraph', null, [math]);
  const doc = schema.nodes.doc.create(null, [paragraph]);
  return buildBoxTree(doc)[0] as ParagraphBlock;
}

describe('equation layout', () => {
  it('produces a math run carrying the converted MathML', () => {
    const block = paragraphWithEquation();
    const run = block.runs[0] as MathRun;

    expect(run.kind).toBe('math');
    expect(run.mathml).toContain('<msup>');
    expect(run.mathml).toContain('<mi>x</mi>');
    expect(run.plainText).toBe('x2');
  });

  it('gives the run a measurable box', () => {
    const run = paragraphWithEquation().runs[0] as MathRun;

    expect(run.width).toBeGreaterThan(0);
    expect(run.height).toBeGreaterThan(0);
    expect(run.ascent).toBeGreaterThan(0);
  });

  it('keeps the document positions the caret resolves against', () => {
    const run = paragraphWithEquation().runs[0] as MathRun;

    expect(run.docFrom).toBe(1);
    expect(run.docTo).toBe(2);
  });

  it('marks a displayed equation as such', () => {
    const run = paragraphWithEquation({ display: 'block' }).runs[0] as MathRun;
    expect(run.display).toBe('block');
  });

  it('lays the equation out on a line at least as tall as its box', () => {
    const block = paragraphWithEquation();
    const run = block.runs[0] as MathRun;
    const metrics = paragraphLayout(block, 600);

    expect(metrics.lines.length).toBe(1);
    expect(metrics.lines[0].lineHeight).toBeGreaterThanOrEqual(run.height);
    // The line reserves the equation's width, or the caret would land inside it.
    expect(metrics.lines[0].width).toBeCloseTo(run.width, 5);
  });

  it('still lays out an equation whose OMML cannot be converted', () => {
    const block = paragraphWithEquation({ ommlXml: 'not xml at all' });
    const run = block.runs[0] as MathRun;

    expect(run.mathml).toBe('');
    expect(run.width).toBeGreaterThan(0);
    expect(paragraphLayout(block, 600).lines.length).toBe(1);
  });
});

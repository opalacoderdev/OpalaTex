import { describe, expect, test } from 'bun:test';
import type {
  ContentNode,
  ImageRun,
  LayoutMetrics,
  ParagraphBlock,
  TextBoxBlock,
} from '../../pagination-model/types';
import { layOutPages } from '../../pagination-model/pageComposer';
import {
  pageGeometryFromPage,
  resolveAnchoredObjectPosition,
  resolveAnchoredObjectVerticalTop,
} from '../../painter-model/anchoredObjectPosition';
import { imageWrapTextFromCssFloat } from '../../painter-model/floatingImageFlow';
import { rectsToFloatingZones, type FloatingImageZone } from '../metrics/floatingZones';
import {
  measureBlocksWithFloats,
  type FloatPageGeometry,
  type MeasureBlockFn,
} from '../metrics/measureBlocksPipeline';

const initialGeometry: FloatPageGeometry = {
  pageWidth: 400,
  pageHeight: 120,
  marginLeft: 50,
  marginRight: 50,
  marginTop: 10,
  marginBottom: 10,
  contentWidth: 300,
  contentHeight: 100,
};

const laterGeometry: FloatPageGeometry = {
  pageWidth: 600,
  pageHeight: 220,
  marginLeft: 80,
  marginRight: 80,
  marginTop: 40,
  marginBottom: 20,
  contentWidth: 440,
  contentHeight: 160,
};

function paragraph(id: string, runs: ParagraphBlock['runs'] = []): ParagraphBlock {
  return { kind: 'paragraph', id, runs };
}

function floatingImage(posOffsetPx: number): ImageRun {
  return {
    kind: 'image',
    src: 'embedded.png',
    width: 40,
    height: 25,
    displayMode: 'float',
    wrapType: 'square',
    position: {
      horizontal: { relativeTo: 'margin', posOffset: posOffsetPx * 9_525 },
      vertical: { relativeTo: 'margin', posOffset: 70 * 9_525 },
    },
  };
}

interface FinalCall {
  width: number;
  zones?: FloatingImageZone[];
  cumulativeY?: number;
}

function recordingMeasure(
  heights: Record<string, number>,
  finalCalls: Map<string, FinalCall>
): MeasureBlockFn {
  const calls = new Map<string, number>();
  return (block, width, zones, cumulativeY): LayoutMetrics => {
    const id = String(block.id);
    const call = (calls.get(id) ?? 0) + 1;
    calls.set(id, call);
    if (call === 2) finalCalls.set(id, { width, zones, cumulativeY });

    switch (block.kind) {
      case 'paragraph': {
        const height = (zones ? heights[`${id}:wrapped`] : undefined) ?? heights[id] ?? 20;
        return {
          kind: 'paragraph',
          lines: [
            {
              fromRun: 0,
              fromChar: 0,
              toRun: 0,
              toChar: 0,
              width: 0,
              ascent: height * 0.75,
              descent: height * 0.25,
              lineHeight: height,
            },
          ],
          totalHeight: height,
        };
      }
      case 'textBox':
        return {
          kind: 'textBox',
          width: block.width,
          height: block.height ?? 20,
          innerMetrics: [],
        };
      case 'sectionBreak':
        return { kind: 'sectionBreak' };
      case 'pageBreak':
        return { kind: 'pageBreak' };
      case 'columnBreak':
        return { kind: 'columnBreak' };
      case 'image':
        return { kind: 'image', width: block.width, height: block.height };
      case 'table':
        return {
          kind: 'table',
          rows: [],
          columnWidths: [],
          totalWidth: width,
          totalHeight: heights[id] ?? 20,
        };
    }
  };
}

function bandAwareMeasure(
  heights: Record<string, number>,
  finalCalls: Map<string, FinalCall>
): MeasureBlockFn {
  return (block, width, zones, cumulativeY = 0): LayoutMetrics => {
    if (zones) finalCalls.set(String(block.id), { width, zones, cumulativeY });

    switch (block.kind) {
      case 'paragraph': {
        const lineHeight = heights[String(block.id)] ?? 10;
        const band = zones?.find(
          (zone) =>
            zone.fullWidthBlock &&
            cumulativeY + lineHeight > zone.topY &&
            cumulativeY < zone.bottomY
        );
        const floatSkipBefore = band ? Math.max(0, band.bottomY - cumulativeY) : 0;
        return {
          kind: 'paragraph',
          lines: [
            {
              fromRun: 0,
              fromChar: 0,
              toRun: 0,
              toChar: 0,
              width: 0,
              ascent: lineHeight * 0.75,
              descent: lineHeight * 0.25,
              lineHeight,
              ...(floatSkipBefore > 0 ? { floatSkipBefore } : {}),
            },
          ],
          totalHeight: lineHeight + floatSkipBefore,
        };
      }
      case 'textBox':
        return {
          kind: 'textBox',
          width: block.width,
          height: block.height ?? 20,
          innerMetrics: [],
        };
      case 'sectionBreak':
        return { kind: 'sectionBreak' };
      case 'pageBreak':
        return { kind: 'pageBreak' };
      case 'columnBreak':
        return { kind: 'columnBreak' };
      case 'image':
        return { kind: 'image', width: block.width, height: block.height };
      case 'table':
        return {
          kind: 'table',
          rows: [],
          columnWidths: [],
          totalWidth: width,
          totalHeight: heights[String(block.id)] ?? 20,
        };
    }
  };
}

function centeredPageBand(id: string): TextBoxBlock {
  return {
    kind: 'textBox',
    id,
    width: 100,
    height: 20,
    content: [],
    displayMode: 'float',
    wrapType: 'topAndBottom',
    distBottom: 5,
    position: {
      vertical: { relativeTo: 'page', align: 'center' },
      horizontal: { relativeTo: 'margin', align: 'left' },
    },
  };
}

describe('floating exclusion flow scopes', () => {
  test('does not remeasure nodes when no float zone applies', () => {
    const nodes = [paragraph('one'), paragraph('two'), paragraph('three')];
    let calls = 0;
    const measure = recordingMeasure({}, new Map());
    const measured = measureBlocksWithFloats(
      nodes,
      300,
      (...args) => {
        calls++;
        return measure(...args);
      },
      initialGeometry
    );

    expect(measured).toHaveLength(3);
    expect(calls).toBe(3);
  });

  test('a bottom-page float cannot affect the following page', () => {
    const nodes: ContentNode[] = [
      paragraph('anchor', [floatingImage(0)]),
      paragraph('page-one-tail'),
      paragraph('page-two'),
    ];
    const finalCalls = new Map<string, FinalCall>();

    const metrics = measureBlocksWithFloats(
      nodes,
      300,
      recordingMeasure(
        { anchor: 20, 'page-one-tail': 70, 'page-two': 20, 'page-two:wrapped': 50 },
        finalCalls
      ),
      initialGeometry
    );

    expect(finalCalls.get('anchor')?.zones).toHaveLength(1);
    expect(finalCalls.get('page-one-tail')?.zones).toHaveLength(1);
    expect(metrics[2]).toMatchObject({ kind: 'paragraph', totalHeight: 20 });
  });

  test('page-anchored topAndBottom images reserve their painted vertical band', () => {
    const image: ImageRun = {
      kind: 'image',
      src: 'embedded.png',
      width: 80,
      height: 20,
      displayMode: 'float',
      wrapType: 'topAndBottom',
      distTop: 3,
      distBottom: 5,
      position: {
        horizontal: { relativeTo: 'margin', align: 'center' },
        vertical: { relativeTo: 'page', align: 'center' },
      },
    };
    const nodes: ContentNode[] = [paragraph('image-anchor', [image]), paragraph('band-overlap')];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(nodes, 300, recordingMeasure({}, finalCalls), initialGeometry);

    expect(finalCalls.get('image-anchor')?.zones?.[0]).toMatchObject({
      leftMargin: 0,
      rightMargin: 0,
      topY: 37,
      bottomY: 65,
      fullWidthBlock: true,
    });
    expect(finalCalls.get('band-overlap')?.zones?.[0]).toMatchObject({
      topY: 37,
      bottomY: 65,
      fullWidthBlock: true,
    });
  });

  test('top-margin topAndBottom images keep their page-relative band after preceding text', () => {
    const image: ImageRun = {
      kind: 'image',
      src: 'embedded.png',
      width: 80,
      height: 60,
      displayMode: 'float',
      wrapType: 'topAndBottom',
      position: {
        horizontal: { relativeTo: 'margin', align: 'center' },
        vertical: { relativeTo: 'topMargin', align: 'top' },
      },
    };
    const geometry: FloatPageGeometry = {
      pageWidth: 400,
      pageHeight: 300,
      marginLeft: 40,
      marginRight: 60,
      marginTop: 30,
      marginBottom: 70,
      contentWidth: 300,
      contentHeight: 200,
    };
    const nodes: ContentNode[] = [paragraph('preceding-text'), paragraph('image-anchor', [image])];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      nodes,
      300,
      recordingMeasure({ 'preceding-text': 20 }, finalCalls),
      geometry
    );

    expect(finalCalls.get('image-anchor')).toMatchObject({
      cumulativeY: 20,
      zones: [{ topY: -30, bottomY: 30, fullWidthBlock: true }],
    });
  });

  for (const wrapType of ['square', 'tight', 'through'] as const) {
    test(`${wrapType} page-relative zero offsets use the painted content-relative geometry`, () => {
      const image: ImageRun = {
        kind: 'image',
        src: 'embedded.png',
        width: 90,
        height: 70,
        displayMode: 'float',
        wrapType,
        distTop: 5,
        distBottom: 7,
        distLeft: 11,
        distRight: 17,
        position: {
          horizontal: { relativeTo: 'page', posOffset: 0 },
          vertical: { relativeTo: 'page', posOffset: 0 },
        },
      };
      const geometry: FloatPageGeometry = {
        pageWidth: 500,
        pageHeight: 300,
        marginLeft: 40,
        marginRight: 80,
        marginTop: 30,
        marginBottom: 50,
        contentWidth: 380,
        contentHeight: 220,
      };
      const nodes: ContentNode[] = [
        paragraph('preceding-text'),
        paragraph('image-anchor', [image]),
      ];
      const finalCalls = new Map<string, FinalCall>();

      measureBlocksWithFloats(
        nodes,
        geometry.contentWidth,
        recordingMeasure({ 'preceding-text': 20 }, finalCalls),
        geometry
      );

      const resolved = resolveAnchoredObjectPosition(image, 0, geometry.contentWidth, geometry);
      const expectedZone = rectsToFloatingZones(
        [
          {
            ...resolved,
            width: image.width,
            height: image.height,
            distTop: image.distTop ?? 0,
            distBottom: image.distBottom ?? 0,
            distLeft: image.distLeft ?? 12,
            distRight: image.distRight ?? 12,
            wrapText: imageWrapTextFromCssFloat(image.cssFloat),
            wrapType: image.wrapType,
          },
        ],
        geometry.contentWidth
      )[0];

      expect(resolved).toEqual({ x: -40, y: -30, side: 'left' });
      expect(finalCalls.get('image-anchor')?.cumulativeY).toBe(20);
      expect(finalCalls.get('image-anchor')?.zones?.[0]).toEqual(expectedZone);
    });
  }

  test('page-relative alignments share painter geometry after preceding flow', () => {
    const image: ImageRun = {
      kind: 'image',
      src: 'embedded.png',
      width: 100,
      height: 50,
      displayMode: 'float',
      wrapType: 'square',
      distTop: 3,
      distBottom: 9,
      distLeft: 11,
      distRight: 17,
      position: {
        horizontal: { relativeTo: 'page', align: 'center' },
        vertical: { relativeTo: 'page', align: 'center' },
      },
    };
    const geometry: FloatPageGeometry = {
      pageWidth: 500,
      pageHeight: 300,
      marginLeft: 40,
      marginRight: 80,
      marginTop: 30,
      marginBottom: 50,
      contentWidth: 380,
      contentHeight: 220,
    };
    const nodes: ContentNode[] = [paragraph('preceding-text'), paragraph('image-anchor', [image])];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      nodes,
      geometry.contentWidth,
      recordingMeasure({ 'preceding-text': 35 }, finalCalls),
      geometry
    );

    const resolved = resolveAnchoredObjectPosition(image, 0, geometry.contentWidth, geometry);
    const expectedZone = rectsToFloatingZones(
      [
        {
          ...resolved,
          width: image.width,
          height: image.height,
          distTop: image.distTop ?? 0,
          distBottom: image.distBottom ?? 0,
          distLeft: image.distLeft ?? 12,
          distRight: image.distRight ?? 12,
          wrapText: imageWrapTextFromCssFloat(image.cssFloat),
          wrapType: image.wrapType,
        },
      ],
      geometry.contentWidth
    )[0];

    expect(resolved).toEqual({ x: 160, y: 95, side: 'left' });
    expect(finalCalls.get('image-anchor')).toMatchObject({ cumulativeY: 35 });
    expect(finalCalls.get('image-anchor')?.zones?.[0]).toEqual(expectedZone);
  });

  test('paragraph-relative side wraps still follow preceding flow', () => {
    const image: ImageRun = {
      kind: 'image',
      src: 'embedded.png',
      width: 40,
      height: 25,
      displayMode: 'float',
      wrapType: 'square',
      position: {
        horizontal: { relativeTo: 'margin', align: 'left' },
        vertical: { relativeTo: 'paragraph', posOffset: 5 * 9_525 },
      },
    };
    const nodes: ContentNode[] = [paragraph('preceding-text'), paragraph('image-anchor', [image])];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      nodes,
      initialGeometry.contentWidth,
      recordingMeasure({ 'preceding-text': 20 }, finalCalls),
      initialGeometry
    );

    expect(finalCalls.get('image-anchor')).toMatchObject({
      cumulativeY: 20,
      zones: [{ topY: 25, bottomY: 50 }],
    });
  });

  test('bottom-margin topAndBottom images keep their page-relative band after preceding text', () => {
    const image: ImageRun = {
      kind: 'image',
      src: 'embedded.png',
      width: 80,
      height: 20,
      displayMode: 'float',
      wrapType: 'topAndBottom',
      distBottom: 5,
      position: {
        horizontal: { relativeTo: 'margin', align: 'center' },
        vertical: { relativeTo: 'bottomMargin', align: 'top' },
      },
    };
    const geometry: FloatPageGeometry = {
      pageWidth: 400,
      pageHeight: 300,
      marginLeft: 40,
      marginRight: 60,
      marginTop: 30,
      marginBottom: 70,
      contentWidth: 300,
      contentHeight: 200,
    };
    const nodes: ContentNode[] = [paragraph('preceding-text'), paragraph('image-anchor', [image])];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      nodes,
      300,
      recordingMeasure({ 'preceding-text': 40 }, finalCalls),
      geometry
    );

    expect(finalCalls.get('image-anchor')).toMatchObject({
      cumulativeY: 40,
      zones: [{ topY: 200, bottomY: 225, fullWidthBlock: true }],
    });
  });

  test('keeps float wrapping only on the current-page part of a split paragraph', () => {
    const nodes: ContentNode[] = [
      paragraph('split-paragraph', [floatingImage(0), { kind: 'text', text: 'abcdefgh' }]),
      paragraph('following-page'),
    ];

    const measureBlock: MeasureBlockFn = (block, _width, zones) => {
      const id = String(block.id);
      const textRunIndex =
        block.kind === 'paragraph' ? block.runs.findIndex((run) => run.kind === 'text') : -1;
      const textRun =
        block.kind === 'paragraph' && textRunIndex >= 0 ? block.runs[textRunIndex] : undefined;
      const textLength = textRun?.kind === 'text' ? textRun.text.length : 0;
      const ranges =
        id === 'split-paragraph'
          ? zones
            ? [
                [0, 0, 1, 2],
                [1, 2, 1, 4],
                [1, 4, 1, 6],
                [1, 6, 1, 8],
              ]
            : [[0, 0, textRunIndex, textLength]]
          : [[0, 0, 0, 0]];
      const lineHeight = id === 'split-paragraph' ? 40 : 20;
      return {
        kind: 'paragraph',
        lines: ranges.map(([fromRun, fromChar, toRun, toChar]) => ({
          fromRun,
          fromChar,
          toRun,
          toChar,
          width: 0,
          ascent: lineHeight * 0.75,
          descent: lineHeight * 0.25,
          lineHeight,
        })),
        totalHeight: ranges.length * lineHeight,
      };
    };

    const metrics = measureBlocksWithFloats(nodes, 300, measureBlock, initialGeometry);

    expect(metrics[0]).toMatchObject({
      kind: 'paragraph',
      totalHeight: 120,
      lines: [
        { fromChar: 0, toChar: 2 },
        { fromChar: 2, toChar: 4 },
        { fromChar: 4, toChar: 8 },
      ],
    });
    expect(metrics[1]).toMatchObject({ kind: 'paragraph', totalHeight: 20 });
  });

  test('keeps active float zones across a continuous section on the same page', () => {
    const nodes: ContentNode[] = [
      paragraph('anchor', [floatingImage(0)]),
      {
        kind: 'sectionBreak',
        id: 'continuous-section',
        type: 'continuous',
      },
      paragraph('same-page-section'),
    ];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(nodes, 300, recordingMeasure({}, finalCalls), initialGeometry);

    expect(finalCalls.get('same-page-section')).toMatchObject({
      cumulativeY: 20,
      zones: [{ bottomY: 95 }],
    });
  });

  test('uses the current physical page geometry through a continuous section', () => {
    const band = centeredPageBand('current-page-band');
    const nodes: ContentNode[] = [
      paragraph('earlier'),
      {
        kind: 'sectionBreak',
        id: 'continuous-section',
        type: 'continuous',
        pageSize: { w: 400, h: 120 },
        margins: { top: 10, right: 50, bottom: 10, left: 50 },
      },
      band,
      paragraph('same-page-text'),
    ];
    const finalCalls = new Map<string, FinalCall>();
    const metrics = measureBlocksWithFloats(
      nodes,
      [300, 300, 440, 440],
      bandAwareMeasure({ earlier: 45, 'same-page-text': 10 }, finalCalls),
      initialGeometry,
      laterGeometry
    );

    const zone = finalCalls.get('same-page-text')?.zones?.[0];
    expect(zone).toMatchObject({ topY: 40, bottomY: 65, fullWidthBlock: true });
    expect(metrics[3]).toMatchObject({
      kind: 'paragraph',
      lines: [{ lineHeight: 10, floatSkipBefore: 20 }],
    });

    const layout = layOutPages(nodes, metrics, {
      pageSize: { w: 400, h: 120 },
      margins: { top: 10, right: 50, bottom: 10, left: 50 },
      finalPageSize: { w: 600, h: 220 },
      finalMargins: { top: 40, right: 80, bottom: 20, left: 80 },
      bodyBreakType: 'continuous',
    });
    expect(layout.pages).toHaveLength(1);
    expect(pageGeometryFromPage(layout.pages[0])).toEqual(initialGeometry);

    const textFragment = layout.pages[0].fragments.find(
      (fragment) => fragment.nodeId === 'same-page-text'
    );
    const paintedBandTop = resolveAnchoredObjectVerticalTop(
      { width: band.width, height: band.height ?? 0, position: band.position },
      0,
      pageGeometryFromPage(layout.pages[0])
    );
    const paintedBandBottom = paintedBandTop + (band.height ?? 0) + (band.distBottom ?? 0);
    const textTop =
      (textFragment?.y ?? 0) -
      layout.pages[0].margins.top +
      ((metrics[3].kind === 'paragraph' && metrics[3].lines[0]?.floatSkipBefore) || 0);
    expect(zone).toBeDefined();
    expect(paintedBandTop).toBe(zone!.topY);
    expect(textTop).toBeGreaterThanOrEqual(paintedBandBottom);
  });

  test('adopts the continuous section geometry after physical-page overflow', () => {
    const band = centeredPageBand('next-page-band');
    const nodes: ContentNode[] = [
      paragraph('page-one-fill'),
      {
        kind: 'sectionBreak',
        id: 'continuous-section',
        type: 'continuous',
        pageSize: { w: 400, h: 120 },
        margins: { top: 10, right: 50, bottom: 10, left: 50 },
      },
      paragraph('overflowing'),
      band,
      paragraph('next-page-text'),
    ];
    const finalCalls = new Map<string, FinalCall>();
    const metrics = measureBlocksWithFloats(
      nodes,
      [300, 300, 440, 440, 440],
      bandAwareMeasure({ 'page-one-fill': 90, overflowing: 65, 'next-page-text': 10 }, finalCalls),
      initialGeometry,
      laterGeometry
    );

    const zone = finalCalls.get('next-page-text')?.zones?.[0];
    expect(zone).toMatchObject({ topY: 60, bottomY: 85, fullWidthBlock: true });
    expect(metrics[4]).toMatchObject({
      kind: 'paragraph',
      lines: [{ lineHeight: 10, floatSkipBefore: 20 }],
    });

    const layout = layOutPages(nodes, metrics, {
      pageSize: { w: 400, h: 120 },
      margins: { top: 10, right: 50, bottom: 10, left: 50 },
      finalPageSize: { w: 600, h: 220 },
      finalMargins: { top: 40, right: 80, bottom: 20, left: 80 },
      bodyBreakType: 'continuous',
    });
    expect(layout.pages).toHaveLength(2);
    expect(pageGeometryFromPage(layout.pages[0])).toEqual(initialGeometry);
    expect(pageGeometryFromPage(layout.pages[1])).toEqual(laterGeometry);

    const textFragment = layout.pages[1].fragments.find(
      (fragment) => fragment.nodeId === 'next-page-text'
    );
    const paintedBandTop = resolveAnchoredObjectVerticalTop(
      { width: band.width, height: band.height ?? 0, position: band.position },
      0,
      pageGeometryFromPage(layout.pages[1])
    );
    const paintedBandBottom = paintedBandTop + (band.height ?? 0) + (band.distBottom ?? 0);
    const textTop =
      (textFragment?.y ?? 0) -
      layout.pages[1].margins.top +
      ((metrics[4].kind === 'paragraph' && metrics[4].lines[0]?.floatSkipBefore) || 0);
    expect(zone).toBeDefined();
    expect(paintedBandTop).toBe(zone!.topY);
    expect(textTop).toBeGreaterThanOrEqual(paintedBandBottom);
  });

  test('keeps physical-page geometry through every continuous-section column', () => {
    const centeredImage: ImageRun = {
      kind: 'image',
      src: 'embedded.png',
      width: 80,
      height: 20,
      displayMode: 'float',
      wrapType: 'topAndBottom',
      distBottom: 5,
      position: {
        horizontal: { relativeTo: 'margin', align: 'center' },
        vertical: { relativeTo: 'page', align: 'center' },
      },
    };
    const columns = { count: 2, gap: 20, equalWidth: true };
    const nodes: ContentNode[] = [
      paragraph('single-column-intro'),
      {
        kind: 'sectionBreak',
        id: 'continuous-columns',
        type: 'continuous',
        pageSize: { w: 400, h: 120 },
        margins: { top: 10, right: 50, bottom: 10, left: 50 },
      },
      paragraph('first-column-fill'),
      paragraph('second-column-anchor', [centeredImage]),
      paragraph('second-column-tail'),
      paragraph('next-page-anchor', [centeredImage]),
    ];
    const finalCalls = new Map<string, FinalCall>();
    const metrics = measureBlocksWithFloats(
      nodes,
      [300, 300, 140, 140, 140, 140],
      bandAwareMeasure(
        {
          'single-column-intro': 20,
          'first-column-fill': 80,
          'second-column-anchor': 25,
          'second-column-tail': 10,
          'next-page-anchor': 65,
        },
        finalCalls
      ),
      initialGeometry,
      { ...laterGeometry, columns }
    );

    expect(finalCalls.get('second-column-anchor')?.zones?.[0]).toMatchObject({
      topY: 40,
      bottomY: 65,
    });
    expect(finalCalls.get('next-page-anchor')?.zones?.[0]).toMatchObject({
      topY: 60,
      bottomY: 85,
    });

    const layout = layOutPages(nodes, metrics, {
      pageSize: { w: 400, h: 120 },
      margins: { top: 10, right: 50, bottom: 10, left: 50 },
      finalPageSize: { w: 600, h: 220 },
      finalMargins: { top: 40, right: 80, bottom: 20, left: 80 },
      columns,
      bodyBreakType: 'continuous',
    });
    expect(layout.pages).toHaveLength(2);
    expect(pageGeometryFromPage(layout.pages[0])).toEqual(initialGeometry);
    expect(pageGeometryFromPage(layout.pages[1])).toEqual(laterGeometry);
    expect(
      layout.pages[0].fragments.find((fragment) => fragment.nodeId === 'second-column-anchor')
        ?.columnIndex
    ).toBe(1);
    expect(
      layout.pages[1].fragments.find((fragment) => fragment.nodeId === 'next-page-anchor')
        ?.columnIndex
    ).toBe(0);
  });

  test('a later-section margin band starts at its anchor with later geometry', () => {
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'later-band',
      width: 800,
      height: 40,
      content: [],
      displayMode: 'float',
      wrapType: 'topAndBottom',
      distBottom: 10,
      position: {
        vertical: { relativeTo: 'margin', align: 'top' },
        horizontal: { relativeTo: 'margin', align: 'left' },
      },
    };
    const nodes: ContentNode[] = [
      paragraph('earlier'),
      {
        kind: 'sectionBreak',
        id: 'section',
        pageSize: { w: 400, h: 120 },
        margins: { top: 10, right: 50, bottom: 10, left: 50 },
      },
      textBox,
      paragraph('later-text'),
    ];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      nodes,
      [300, 300, 800, 800],
      recordingMeasure({}, finalCalls),
      initialGeometry,
      {
        pageWidth: 1_000,
        pageHeight: 220,
        marginLeft: 100,
        marginRight: 100,
        marginTop: 20,
        marginBottom: 20,
        contentWidth: 800,
        contentHeight: 180,
      }
    );

    expect(finalCalls.get('earlier')?.zones).toBeUndefined();
    expect(finalCalls.get('section')?.zones).toBeUndefined();
    expect(finalCalls.get('later-band')?.width).toBe(800);
    expect(finalCalls.get('later-band')?.zones?.[0]).toMatchObject({
      fullWidthBlock: true,
      topY: 0,
      bottomY: 50,
    });
    expect(finalCalls.get('later-text')?.zones?.[0].fullWidthBlock).toBe(true);
  });

  test('mixed-width sections resolve each float against its own width', () => {
    const nodes: ContentNode[] = [
      paragraph('narrow-float', [floatingImage(220)]),
      {
        kind: 'sectionBreak',
        id: 'section',
        pageSize: { w: 700, h: 120 },
        margins: { top: 10, right: 50, bottom: 10, left: 50 },
      },
      paragraph('wide-float', [floatingImage(220)]),
    ];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      nodes,
      [300, 300, 600],
      recordingMeasure({}, finalCalls),
      initialGeometry
    );

    expect(finalCalls.get('narrow-float')?.zones?.[0]).toMatchObject({
      leftMargin: 0,
      rightMargin: 0,
      segments: [
        { leftOffset: 0, availableWidth: 208 },
        { leftOffset: 272, availableWidth: 28 },
      ],
    });
    expect(finalCalls.get('wide-float')?.zones?.[0]).toMatchObject({
      leftMargin: 0,
      rightMargin: 0,
      segments: [
        { leftOffset: 0, availableWidth: 208 },
        { leftOffset: 272, availableWidth: 328 },
      ],
    });
  });
});

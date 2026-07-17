import { describe, expect, mock, test } from 'bun:test';

import {
  createPaintedPagesGuard,
  readCurrentPaintedPages,
  transactionNeedsDirectOverlayRequest,
} from './paintedPagesGuard';

describe('painted pages guard', () => {
  test('holds overlay reads until matching pages finish painting', () => {
    const refresh = mock(() => {});
    const guard = createPaintedPagesGuard(refresh);
    guard.finishPaint(guard.startPaint());
    refresh.mockClear();

    guard.noteDocumentChange();
    guard.requestOverlayRefresh();
    expect(refresh).not.toHaveBeenCalled();

    guard.finishPaint(guard.startPaint());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('does not release a request when an older paint finishes', () => {
    const refresh = mock(() => {});
    const guard = createPaintedPagesGuard(refresh);

    guard.noteDocumentChange();
    const olderPaint = guard.startPaint();
    guard.noteDocumentChange();
    guard.requestOverlayRefresh();
    const currentPaint = guard.startPaint();

    expect(guard.finishPaint(olderPaint)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(guard.finishPaint(currentPaint)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('coalesces retained requests and consumes them exactly once', () => {
    const refresh = mock(() => {});
    const guard = createPaintedPagesGuard(refresh);

    guard.noteDocumentChange();
    guard.requestOverlayRefresh();
    guard.requestOverlayRefresh();
    const paint = guard.startPaint();

    guard.finishPaint(paint);
    guard.finishPaint(paint);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('does not refresh without a pending request', () => {
    const refresh = mock(() => {});
    const guard = createPaintedPagesGuard(refresh);

    guard.finishPaint(guard.startPaint());

    expect(refresh).not.toHaveBeenCalled();
    expect(guard.pagesAreCurrent()).toBe(true);
  });

  test('runs selection-only refreshes immediately while pages are current', () => {
    const refresh = mock(() => {});
    const guard = createPaintedPagesGuard(refresh);
    guard.finishPaint(guard.startPaint());
    refresh.mockClear();

    guard.requestOverlayRefresh();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('re-checks page currency before deferred DOM reads', () => {
    const guard = createPaintedPagesGuard(() => {});
    guard.finishPaint(guard.startPaint());
    const read = mock(() => ({ width: 10, height: 20 }));

    guard.noteDocumentChange();

    expect(readCurrentPaintedPages(guard.pagesAreCurrent, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test('classifies transactions that need a direct overlay request', () => {
    expect(transactionNeedsDirectOverlayRequest({ docChanged: false, selectionSet: true })).toBe(
      false
    );
    expect(transactionNeedsDirectOverlayRequest({ docChanged: true, selectionSet: false })).toBe(
      false
    );
    expect(transactionNeedsDirectOverlayRequest({ docChanged: false, selectionSet: false })).toBe(
      true
    );
  });

  test('retains requests after failed paints and ignores work after disposal', () => {
    const refresh = mock(() => {});
    const guard = createPaintedPagesGuard(refresh);

    guard.noteDocumentChange();
    guard.requestOverlayRefresh();
    guard.abandonPaint(guard.startPaint());
    expect(refresh).not.toHaveBeenCalled();

    guard.finishPaint(guard.startPaint());
    expect(refresh).toHaveBeenCalledTimes(1);

    guard.dispose();
    expect(guard.isDisposed()).toBe(true);
    expect(guard.pagesAreCurrent()).toBe(false);
    guard.requestOverlayRefresh();
    guard.finishPaint(guard.startPaint());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('revives without losing current-page state', () => {
    const refresh = mock(() => {});
    const guard = createPaintedPagesGuard(refresh);
    guard.finishPaint(guard.startPaint());

    guard.dispose();
    guard.revive();
    guard.requestOverlayRefresh();

    expect(guard.pagesAreCurrent()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

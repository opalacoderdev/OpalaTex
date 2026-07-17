/**
 * Constants shared by the float model and the line breaker.
 *
 * These two modules are mutually recursive by nature — the float model asks the
 * line breaker to clamp its margins, and the line breaker asks the float model
 * how wide the line is — and that cycle is harmless for *functions*, which are
 * hoisted and only called later.
 *
 * It is not harmless for `const`s. A constant read at module top-level across
 * the cycle hits the temporal dead zone of whichever module happened to be
 * entered second, and the failure depends on import order: it works, until an
 * unrelated file changes what gets loaded first. So the constants live here, in
 * a module that imports nothing and can always be initialised first.
 *
 * @packageDocumentation
 */

/**
 * The narrowest strip of a line worth putting text in, px.
 *
 * Below this a "column" holds roughly one character, which is unreadable and
 * paginates absurdly. Three places have to agree on the number, which is why it
 * is one number:
 *
 *  - the float model, deciding whether a gap beside an object is usable at all
 *    (an image flush with the right margin leaves 2px — that is not a column);
 *  - the line breaker, deciding whether to push a line down past an object
 *    rather than squeeze it in beside;
 *  - the floating-table classifier, deciding whether a "floating" table is
 *    really block-like because nothing can flow next to it.
 *
 * If they disagreed, the breaker would fill a strip the float model had already
 * written off, and text would paint over the object.
 */
export const MIN_WRAP_SEGMENT_WIDTH = 24;

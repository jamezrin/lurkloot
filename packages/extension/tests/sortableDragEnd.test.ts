import { describe, expect, it } from "vitest";
import { reorderFromDragEnd, type SortableDragEndEvent } from "../../popup-ui/src/primitives";

function dragEnd(
  source: { id: string; initialIndex: number; index: number },
  targetId: string,
  canceled = false,
): SortableDragEndEvent {
  return {
    canceled,
    operation: { source, target: { id: targetId } },
  } as unknown as SortableDragEndEvent;
}

describe("reorderFromDragEnd", () => {
  // @dnd-kit/react keeps the pointer over the dragged row after it has already
  // projected that row into the new slot, so source.id === target.id at drop.
  // Matching source/target ids is a no-op if we only look at those ids, which
  // is why ranks stayed stale and the order reverted on popup reopen.
  it("commits a sortable drop even when the pointer is still over the dragged item", () => {
    const list = [{ id: "xqc" }, { id: "xlibano" }, { id: "m2cg" }, { id: "poionako" }];
    const next = reorderFromDragEnd(
      list,
      dragEnd({ id: "poionako", initialIndex: 3, index: 0 }, "poionako"),
    );
    expect(next.map((item) => item.id)).toEqual(["poionako", "xqc", "xlibano", "m2cg"]);
  });

  it("does not reorder a canceled drag", () => {
    const list = [{ id: "a" }, { id: "b" }];
    const next = reorderFromDragEnd(
      list,
      dragEnd({ id: "b", initialIndex: 1, index: 0 }, "b", true),
    );
    expect(next).toBe(list);
  });
});

import { Button } from "@/components/ui/button";

/**
 * The header's Select button (8.11); "Unselect all" in select mode, which unpicks everything and
 * leaves it. One button that keeps its place and width, so the header and the grid below don't move
 * when select mode starts or ends.
 */
export function SelectButton({
  active,
  onSelect,
  onUnselect,
}: {
  active: boolean;
  onSelect: () => void;
  onUnselect: () => void;
}) {
  return (
    <Button
      variant="outline"
      onClick={active ? onUnselect : onSelect}
      className="grid place-items-center"
    >
      {/* Both labels share one grid cell: the wider one sets the width, the other is hidden. */}
      <span
        aria-hidden={active}
        className={active ? "invisible col-start-1 row-start-1" : "col-start-1 row-start-1"}
      >
        Select
      </span>
      <span
        aria-hidden={!active}
        className={active ? "col-start-1 row-start-1" : "invisible col-start-1 row-start-1"}
      >
        Unselect all
      </span>
    </Button>
  );
}

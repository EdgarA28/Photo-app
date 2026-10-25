import { MAX_ALBUM_NAME_LENGTH } from "@photo-app/shared";
import { useId, useState, type ReactNode } from "react";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Album name field + submit, for create and rename (FR-ALB-1). Same rule as the API's
 * `albumNameSchema`: 1–100 characters after trimming. Errors from the API show under the field.
 */
export function AlbumNameForm({
  initialName = "",
  submitLabel,
  pendingLabel,
  isPending,
  error,
  onSubmit,
  secondary,
}: {
  initialName?: string;
  submitLabel: string;
  pendingLabel: string;
  isPending: boolean;
  error: unknown;
  onSubmit: (name: string) => void;
  /** e.g. a Cancel or Back button next to submit. */
  secondary?: ReactNode;
}) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed && !isPending) onSubmit(trimmed);
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={id}>Album name</Label>
        <Input
          id={id}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          maxLength={MAX_ALBUM_NAME_LENGTH}
          autoComplete="off"
          autoFocus
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(error)}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {secondary}
        <Button type="submit" disabled={!trimmed || isPending}>
          {isPending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

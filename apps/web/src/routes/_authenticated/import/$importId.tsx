import { idSchema, type Import, type ImportFailureCode } from "@photo-app/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { ImportStartButton, LOCATION_HINT } from "@/import/ImportStart";
import { markPickerOpened, openPicker, pickerUriOf, wasPickerOpened } from "@/import/pickerStore";
import { importQuery, useReturnedFromPicker } from "@/queries/imports";
import { refreshAfterUpload } from "@/queries/photos";

/**
 * One import from Google Photos (13.5g, FR-IMP-5): pick in Google's picker, then follow the copy
 * and read the summary. The copy runs in the backend (FR-IMP-4), so the app may close meanwhile;
 * coming back here (or not) changes nothing.
 */
export const Route = createFileRoute("/_authenticated/import/$importId")({
  params: {
    parse: ({ importId }) => {
      if (!idSchema.safeParse(importId).success) throw notFound();
      return { importId };
    },
    stringify: ({ importId }) => ({ importId }),
  },
  component: ImportPage,
});

const FAILURE_TEXT: Record<ImportFailureCode, string> = {
  TOO_LARGE: "larger than 50 MB",
  QUOTA_EXCEEDED: "storage full",
  NOT_FOUND: "no longer in Google Photos",
  EXPIRED: "Google's access ran out",
};

const photos = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);

/** "Imported 48 photos · 2 skipped (videos or other types) · 1 not imported: storage full" */
export function importSummary(data: Import): string {
  const parts = [`Imported ${photos(data.done)}`];
  if (data.skipped > 0) parts.push(`${data.skipped} skipped (videos or other types)`);
  for (const [code, count] of Object.entries(data.failedReasons)) {
    if (count) parts.push(`${count} not imported: ${FAILURE_TEXT[code as ImportFailureCode]}`);
  }
  return parts.join(" · ");
}

function ImportPage() {
  const { importId } = Route.useParams();
  const { api } = Route.useRouteContext();
  const queryClient = useQueryClient();
  // Opened in this tab (kept over a reload: Android may reload the app on the way back).
  const [opened, setOpened] = useState(() => wasPickerOpened(importId));
  // Back from Google Photos: from then on the page shows progress at once (user 2026-11-22: the
  // bar came seconds after Done, or not at all for a few photos).
  const returned = useReturnedFromPicker(opened);
  const { data, error, refetch } = useQuery(importQuery(api, importId, { active: opened }));
  const pickerUri = pickerUriOf(importId);
  const cancel = useMutation({
    mutationFn: () => api.imports.cancel(importId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["imports", importId] }),
  });

  // Ask at once instead of waiting for the next poll.
  useEffect(() => {
    if (returned) void refetch();
  }, [returned, refetch]);

  // New photos show up as processing tiles while they're copied (FR-IMP-4): refresh the gallery
  // and usage as the count grows and once more at the end.
  const counted = data ? data.done : 0;
  const shown = useRef(0);
  useEffect(() => {
    if (counted > shown.current || (data && data.status === "done")) {
      shown.current = counted;
      void refreshAfterUpload(queryClient);
    }
  }, [counted, data, queryClient]);

  return (
    <main className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Import from Google Photos</h1>
      {!data ? (
        error ? (
          <>
            <p className="text-muted-foreground">{errorMessage(error)}</p>
            <Button variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">Loading…</p>
        )
      ) : (
        <ImportState
          data={data}
          pickerUri={pickerUri}
          opened={opened}
          returned={returned}
          onOpen={() => {
            if (!pickerUri) return;
            openPicker(pickerUri);
            markPickerOpened(importId);
            setOpened(true);
          }}
          cancelling={cancel.isPending}
          onCancel={() => cancel.mutate()}
        />
      )}
      {cancel.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(cancel.error)}
        </p>
      )}
    </main>
  );
}

/** Indeterminate (no value) while we wait, filling as photos are counted, full at the end. */
function ImportProgress({ value, max }: { value?: number; max?: number }) {
  return (
    <progress
      className="h-2 w-full accent-primary"
      aria-label="Import progress"
      {...(value !== undefined && { value, max: Math.max(1, max ?? value) })}
    />
  );
}

function ImportState({
  data,
  pickerUri,
  opened,
  returned,
  onOpen,
  cancelling,
  onCancel,
}: {
  data: Import;
  pickerUri: string | null;
  opened: boolean;
  returned: boolean;
  onOpen: () => void;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const cancelButton = (
    <Button variant="outline" disabled={cancelling} onClick={onCancel}>
      {cancelling ? "Cancelling…" : "Cancel import"}
    </Button>
  );

  switch (data.status) {
    case "picking":
      if (returned) {
        // Most likely Done was tapped; the next status check confirms it (1.5 s polling).
        return (
          <>
            <p>Preparing your photos…</p>
            <ImportProgress />
            <p className="text-sm text-muted-foreground">
              Waiting for Google Photos to confirm your choice. Didn't tap Done there?{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={onOpen}
                disabled={!pickerUri}
              >
                Open Google Photos again
              </button>
            </p>
            {cancelButton}
          </>
        );
      }
      return pickerUri ? (
        <ChoosePhotos opened={opened} onOpen={onOpen} cancelButton={cancelButton} />
      ) : (
        <>
          <p className="text-muted-foreground">
            Waiting for you to choose photos in Google Photos, in the tab or app where you started
            this import. This page continues by itself once you're done.
          </p>
          {cancelButton}
        </>
      );
    case "listing":
      return (
        <>
          <p>Preparing your photos…</p>
          <ImportProgress />
          {cancelButton}
        </>
      );
    case "copying": {
      const handled = data.done + data.failed;
      return (
        <>
          <p>
            Copying {handled} of {photos(data.total)}…
          </p>
          <ImportProgress value={handled} max={data.total} />
          <p className="text-sm text-muted-foreground">
            You can close the app: the import goes on.
          </p>
          {cancelButton}
        </>
      );
    }
    case "done":
      return (
        <>
          {data.total > 0 && <ImportProgress value={data.total} max={data.total} />}
          <p role="status">{importSummary(data)}.</p>
          {data.done > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                New photos appear in the gallery by the date they were taken, after a short
                processing.
              </p>
              <p className="text-sm text-muted-foreground">{LOCATION_HINT}</p>
            </>
          )}
          <Finished />
        </>
      );
    case "cancelled":
      return (
        <>
          <p role="status">
            Import cancelled.{data.done > 0 ? ` ${importSummary(data)} before that.` : ""}
          </p>
          <Finished />
        </>
      );
    case "expired":
      return (
        <>
          <p role="status">
            {data.total === 0
              ? "The time to choose photos ran out. Start a new import."
              : `The import ran out of time. ${importSummary(data)}.`}
          </p>
          <Finished />
        </>
      );
  }
}

/**
 * The one step left after Google's consent (user's choice 2026-11-22: keep the second tap, make it
 * obvious). The picker can only open from a tap (popup blockers, §11.5), and Google sends no one
 * back to the app, so this page waits for the Done in Google Photos by polling.
 */
function ChoosePhotos({
  opened,
  onOpen,
  cancelButton,
}: {
  opened: boolean;
  onOpen: () => void;
  cancelButton: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <p>
        {opened
          ? "Pick your photos in Google Photos and tap Done there. This page continues by itself."
          : "Google Photos is connected. One more step: choose the photos to copy."}
      </p>
      <Button
        size="lg"
        variant={opened ? "outline" : "default"}
        className="h-12 w-full text-base sm:w-auto sm:px-6"
        onClick={onOpen}
      >
        {opened ? "Open Google Photos again" : "Choose your photos"}
      </Button>
      <p className="text-sm text-muted-foreground">
        Opens Google Photos. Up to 500 photos; videos are skipped.
      </p>
      {cancelButton}
    </div>
  );
}

function Finished() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild>
        <Link to="/gallery">Go to gallery</Link>
      </Button>
      <ImportStartButton>Import more</ImportStartButton>
    </div>
  );
}

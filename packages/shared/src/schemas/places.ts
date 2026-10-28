import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Places (13.2): where photos were taken, from EXIF GPS via an offline lookup in the thumbnail
 * Lambda (§10). Owner only (not shown to share recipients). Photos carry names only; coordinates
 * leave the backend only for the owner's map, rounded (GET /places/map, 13.2h, FR-SRCH-5).
 */

/** `city:{GeoNames ID}`, `region:{country code}.{admin1 code}` or `country:{country code}`. */
export const placeIdSchema = z
  .string()
  .regex(/^(city:\d{1,12}|region:[A-Z]{2}\.[0-9A-Za-z]{1,20}|country:[A-Z]{2})$/);

export const placeKindSchema = z.enum(["city", "region", "country"]);
export type PlaceKind = z.infer<typeof placeKindSchema>;

/** On a photo: the town it was taken in, with its region and country. */
export const photoPlaceSchema = z.object({
  city: z.string(),
  region: z.string().nullable(),
  country: z.string(),
});
export type PhotoPlace = z.infer<typeof photoPlaceSchema>;

/** One of the caller's places, for search (GET /places). */
export const placeSchema = z.object({
  placeId: placeIdSchema,
  kind: placeKindSchema,
  name: z.string(),
  /** Shown under the name: "Bavaria, Germany" for a city, the country for a region, "" for a country. */
  context: z.string(),
  photoCount: z.number().int().positive(),
});
export type Place = z.infer<typeof placeSchema>;

/** GET /places: all of the caller's places, most photos first. */
export const placeListSchema = z.object({ items: z.array(placeSchema) });
export type PlaceList = z.infer<typeof placeListSchema>;

/** Map coordinates are rounded to 3 decimals, about 100 m (13.2h, FR-SRCH-5). */
export const MAP_COORDINATE_DECIMALS = 3;

/** One of the caller's photos with GPS, as a map pin (GET /places/map). */
export const photoLocationSchema = z.object({
  photoId: idSchema,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  takenAt: isoDateTimeSchema,
  thumbUrl: z.string(),
  /** The town it was taken in (a `city:` place); null without a town nearby. */
  placeId: placeIdSchema.nullable(),
});
export type PhotoLocation = z.infer<typeof photoLocationSchema>;

/** GET /places/map: all of the caller's ready photos with GPS, newest first. */
export const photoLocationListSchema = z.object({ items: z.array(photoLocationSchema) });
export type PhotoLocationList = z.infer<typeof photoLocationListSchema>;

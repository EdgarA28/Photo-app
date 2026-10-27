import { z } from "zod";

/**
 * Places (13.2): where photos were taken, from EXIF GPS via an offline lookup in the thumbnail
 * Lambda (§10). Names only: coordinates never leave the backend. Owner only (not shown to share
 * recipients).
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

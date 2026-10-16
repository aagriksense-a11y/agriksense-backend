import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { koboToNairaString, isoDate } from '../lib/serializers';
import { unprocessable } from '../lib/errors';

export interface Point {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_MILES = 3958.7613;

/** Great-circle distance in miles. */
export function haversineMiles(a: Point, b: Point): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/** Approximate road distance: straight-line distance × configured road factor. */
export const roadMiles = (a: Point, b: Point) => haversineMiles(a, b) * env.fareRoadFactor;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const ROUTING_ASSUMPTIONS = () => ({
  distance_unit: 'mile',
  method: 'haversine_great_circle',
  road_factor: env.fareRoadFactor,
  note: 'Distances are straight-line distances multiplied by the road factor; no routing provider is used.',
});

/** The rate in force for a state today (latest effective_from on or before today). */
export async function currentFareRate(stateId: number, on: Date = new Date()) {
  return prisma.fareRate.findFirst({
    where: { stateId, effectiveFrom: { lte: on } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export async function requireFareRate(stateId: number) {
  const rate = await currentFareRate(stateId);
  if (!rate) throw unprocessable('No fare rate is configured for this state', [{ field: 'state_id', reason: 'fare rate not set' }], 'FARE_RATE_NOT_SET');
  return rate;
}

export const serializeRate = (r: { stateId: number; koboPerMile: number; effectiveFrom: Date }) => ({
  state_id: r.stateId,
  naira_per_mile: koboToNairaString(r.koboPerMile),
  kobo_per_mile: r.koboPerMile,
  effective_from: isoDate(r.effectiveFrom),
});

export interface FareStop extends Point {
  key: string;
}

/**
 * Individual fares: each farm visited as its own return trip (origin → farm → origin).
 * Grouped fare: one trip visiting all farms in nearest-neighbour order, then back to origin.
 */
export function estimateFares(origin: Point, stops: FareStop[], koboPerMile: number) {
  const perStop = stops.map((s) => {
    // Fares are computed from the displayed (2 dp) distance so amounts reconcile exactly.
    const oneWay = round2(roadMiles(origin, s));
    const roundTrip = round2(oneWay * 2);
    return { key: s.key, one_way_miles: oneWay, round_trip_miles: roundTrip, fare_kobo: Math.round(roundTrip * koboPerMile) };
  });
  const individualTotal = perStop.reduce((sum, s) => sum + s.fare_kobo, 0);

  const remaining = [...stops];
  const route: string[] = [];
  let current: Point = origin;
  let miles = 0;
  while (remaining.length) {
    let bestIdx = 0;
    let best = Infinity;
    remaining.forEach((s, i) => {
      const d = roadMiles(current, s);
      if (d < best) {
        best = d;
        bestIdx = i;
      }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    miles += best;
    route.push(next.key);
    current = next;
  }
  miles = round2(miles + roadMiles(current, origin));
  const groupedFare = Math.round(miles * koboPerMile);
  return {
    per_farm: perStop,
    individual_total_kobo: individualTotal,
    grouped: { route, total_miles: miles, fare_kobo: groupedFare, savings_kobo: Math.max(0, individualTotal - groupedFare) },
  };
}

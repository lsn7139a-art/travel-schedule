/* 我的行程：localStorage 持久化 */
const KEY = 'tripmap.trips';

export function getTrips() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveTrip(trip) {
  const trips = getTrips();
  trip.updatedAt = Date.now();
  const i = trips.findIndex(t => t.id === trip.id);
  if (i >= 0) trips[i] = trip; else trips.push(trip);
  localStorage.setItem(KEY, JSON.stringify(trips));
}

export function deleteTrip(id) {
  localStorage.setItem(KEY, JSON.stringify(getTrips().filter(t => t.id !== id)));
}

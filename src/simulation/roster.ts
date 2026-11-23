import type { Role } from "./types";

/** The simulated occupants (fictional names). */
export const ROSTER: Array<{ id: string; name: string; role: Role; callsign?: string }> = [
    { id: "v01", name: "Léa Martin", role: "visitor" },
    { id: "v02", name: "Hugo Bernard", role: "visitor" },
    { id: "v03", name: "Emma Rossi", role: "visitor" },
    { id: "v04", name: "Noah Weber", role: "visitor" },
    { id: "v05", name: "Chloé Dubois", role: "visitor" },
    { id: "v06", name: "Lucas Ferrari", role: "visitor" },
    { id: "v07", name: "Inès Moreau", role: "visitor" },
    { id: "v08", name: "Sofia Garcia", role: "visitor" },
    { id: "v09", name: "Mateo Silva", role: "visitor" },
    { id: "s01", name: "Camille Laurent", role: "staff" },
    { id: "s02", name: "Julien Petit", role: "staff" },
    { id: "s03", name: "Sarah Cohen", role: "staff" },
    { id: "g01", name: "Marc Lefèvre", role: "security" },
    { id: "g02", name: "Nadia Benali", role: "security" },
    { id: "m01", name: "Paul Girard", role: "medic" },
    { id: "m02", name: "Amélie Roux", role: "medic" },
    { id: "f01", name: "Thomas Blanc", role: "firefighter", callsign: "FF-01" },
    { id: "f02", name: "Karim Haddad", role: "firefighter", callsign: "FF-02" },
    { id: "f03", name: "Elena Costa", role: "firefighter", callsign: "FF-03" },
    { id: "f04", name: "Pierre Morel", role: "firefighter", callsign: "FF-04" },
];

//! What a cell id is — `FR-006`, `FR-058`, `FR-060`.
//!
//! `register_sensor` takes a cell id from whoever registers, and nothing about
//! a `u64` says it names a place. A number that is not an H3 cell would open a
//! cell account nobody can locate, and a cell of the wrong grid level would sit
//! beside the network's cells without ever overlapping one — a sensor voting,
//! honestly and forever, in a cell no policy can be written on.
//!
//! This is `isValidCell` from H3, reduced to its bit layout. It has a twin in
//! `h3-js`, the library the rest of the system uses, and both run
//! `fixtures/h3-cells.json` — generated *from* `h3-js` — so the program and the
//! interface cannot disagree about which numbers are cells.
//!
//! Layout of an H3 cell index, high bit first: one reserved bit (0), four bits
//! of mode (1 for a cell), three reserved bits (0), four bits of resolution,
//! seven bits of base cell (0..=121), then fifteen three-bit digits. Digits up
//! to the resolution are 0..=6; the rest are all 7.

/// Base cells that are pentagons. A pentagon has no neighbour along the K axis,
/// so its descendants may not take digit 1 as their first non-zero digit.
const PENTAGON_BASE_CELLS: [u8; 12] = [4, 14, 24, 38, 49, 58, 63, 72, 83, 97, 107, 117];

const BASE_CELLS: u8 = 122;
const MAX_RESOLUTION: u8 = 15;
const CELL_MODE: u64 = 1;

fn digit(id: u64, resolution: u8) -> u8 {
    ((id >> ((MAX_RESOLUTION - resolution) as u32 * 3)) & 0b111) as u8
}

/// The grid level of a cell id, read out of the id.
pub fn resolution(id: u64) -> u8 {
    ((id >> 52) & 0xf) as u8
}

/// True when the id names a cell H3 has, not merely one shaped like it.
pub fn is_cell(id: u64) -> bool {
    if id >> 63 != 0 {
        return false;
    }
    if (id >> 59) & 0xf != CELL_MODE {
        return false;
    }
    if (id >> 56) & 0b111 != 0 {
        return false;
    }

    let res = resolution(id);
    let base_cell = ((id >> 45) & 0x7f) as u8;
    if base_cell >= BASE_CELLS {
        return false;
    }

    let pentagon = PENTAGON_BASE_CELLS.contains(&base_cell);
    let mut leading_zeroes = true;
    for r in 1..=MAX_RESOLUTION {
        let d = digit(id, r);
        if r <= res {
            if d == 7 {
                return false;
            }
            if leading_zeroes && d != 0 {
                if pentagon && d == 1 {
                    return false;
                }
                leading_zeroes = false;
            }
        } else if d != 7 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        id: String,
        valid: bool,
        res: Option<u8>,
        why: String,
    }

    #[derive(Deserialize)]
    struct Fixtures {
        cases: Vec<Case>,
    }

    #[test]
    fn agrees_with_h3_js_on_every_fixture_case() {
        let raw = include_str!("../../../fixtures/h3-cells.json");
        let fixtures: Fixtures = serde_json::from_str(raw).expect("fixtures parse");
        assert!(fixtures.cases.iter().any(|case| case.valid));
        assert!(fixtures.cases.iter().any(|case| !case.valid));

        for case in fixtures.cases {
            let id: u64 = case.id.parse().expect("id is a u64");
            assert_eq!(is_cell(id), case.valid, "{}: {}", case.why, case.id);
            if let Some(res) = case.res {
                assert_eq!(resolution(id), res, "{}: {}", case.why, case.id);
            }
        }
    }
}

// Romanian VAT groups — mirror of fiscal-bridge/bridge/printers/datecs_dp25.py:43-48.
// Tenant override planned via DatecsConfig.vat_map (see audit §5.1).
//
// Since 1 Aug 2025 the Romanian rates are 21% (standard, group A) and 11%
// (reduced, group B). The pre-2025 rates 19% / 9% stay mapped to the same
// groups so an old fiscal config (or a backend snapshot from before the
// switch) still lands on the right register. Before this mapping knew about
// 11%, a food line at 11% silently fell through to group A (21%).

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.0005
}

/// Accepts a fraction (0.21) or, defensively, a percentage (21.0).
fn normalise(rate: f64) -> f64 {
    if rate > 1.0 {
        rate / 100.0
    } else {
        rate
    }
}

pub fn rate_to_group(rate: f64) -> char {
    let r = normalise(rate);
    if approx(r, 0.21) || approx(r, 0.19) {
        'A'
    } else if approx(r, 0.11) || approx(r, 0.09) {
        'B'
    } else if approx(r, 0.05) {
        'C'
    } else if approx(r, 0.0) {
        'D'
    } else {
        // Unknown rate — fall back to A (standard rate) so the receipt still
        // prints. Server is the source of truth for the rate on the bon.
        log::warn!("vat: unknown rate {rate} — falling back to group A");
        'A'
    }
}

/// DP-25X register_item wants the VAT group as a NUMERIC field (1..5),
/// not the FP-55-era letter prefix `T<A..D>`. Per the Oblio mapping
/// documented for Datecs DP-25:
///   1 = 21% (cota A), 2 = 11% (B), 3 = 5% (C), 4 = 0% (D), 5 = nepl. TVA.
/// Confirmed against a DUDE register_item capture (TX 528) where field
/// #2 was `1` for a TVA-A item.
pub fn rate_to_dp25x_id(rate: f64) -> u8 {
    match rate_to_group(rate) {
        'A' => 1,
        'B' => 2,
        'C' => 3,
        'D' => 4,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_romanian_rates() {
        assert_eq!(rate_to_dp25x_id(0.21), 1);
        assert_eq!(rate_to_dp25x_id(0.11), 2);
        assert_eq!(rate_to_dp25x_id(0.05), 3);
        assert_eq!(rate_to_dp25x_id(0.0), 4);
    }

    #[test]
    fn legacy_rates_keep_their_groups() {
        assert_eq!(rate_to_group(0.19), 'A');
        assert_eq!(rate_to_group(0.09), 'B');
    }

    #[test]
    fn percentages_are_accepted() {
        assert_eq!(rate_to_group(21.0), 'A');
        assert_eq!(rate_to_group(11.0), 'B');
    }

    #[test]
    fn unknown_rate_falls_back_to_a() {
        assert_eq!(rate_to_group(0.42), 'A');
    }
}

// Romanian VAT groups — mirror of fiscal-bridge/bridge/printers/datecs_dp25.py:43-48.
// Tenant override planned via DatecsConfig.vat_map (see audit §5.1).

pub fn rate_to_group(rate: f64) -> char {
    let r = (rate * 10000.0).round() / 10000.0;
    if (r - 0.19).abs() < f64::EPSILON {
        'A'
    } else if (r - 0.09).abs() < f64::EPSILON {
        'B'
    } else if (r - 0.05).abs() < f64::EPSILON {
        'C'
    } else if r.abs() < f64::EPSILON {
        'D'
    } else {
        // Unknown rate — log + fall back to A (19%) so the receipt still
        // prints with the most common Romanian rate. Server is the source
        // of truth for the rate that ends up on the bon.
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

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

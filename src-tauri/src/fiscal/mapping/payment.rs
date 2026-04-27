use crate::fiscal::dto::PaymentMethod;

// DP-25 payment type code, from datecs_dp25.py:_PAYMENT_MAP.
pub fn method_to_code(method: &PaymentMethod) -> &'static str {
    match method {
        PaymentMethod::Cash | PaymentMethod::Other => "0",
        PaymentMethod::Card => "2",
        PaymentMethod::Voucher => "3",
    }
}

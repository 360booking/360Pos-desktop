/**
 * /api/pos/orders/{id}/claim + /release client.
 * Sprint 7.
 */
import { getApiClient } from './client';

export type ClaimStatus = 'claimed' | 'already_owned' | 'conflict' | 'failed';

export interface ClaimOrderRequest {
  deviceId: string;
  tenantId?: string | null;
  restaurantId?: string | null;
  force?: boolean;
}

export interface ClaimOrderResponse {
  status: ClaimStatus;
  orderId: string;
  ownerDeviceId: string | null;
  expiresAt: string | null;
  message: string | null;
}

export async function claimOrder(
  orderId: string,
  body: ClaimOrderRequest,
): Promise<ClaimOrderResponse> {
  const r = await getApiClient().post<ClaimOrderResponse>(
    `/api/pos/orders/${encodeURIComponent(orderId)}/claim`,
    body,
  );
  return r.data;
}

export async function releaseOrder(
  orderId: string,
  deviceId: string,
): Promise<ClaimOrderResponse> {
  const r = await getApiClient().post<ClaimOrderResponse>(
    `/api/pos/orders/${encodeURIComponent(orderId)}/release`,
    { deviceId },
  );
  return r.data;
}

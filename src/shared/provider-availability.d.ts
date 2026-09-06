export interface ProviderAvailability {
  providerId: string;
  status: "available" | "authentication_required" | "unavailable" | "unknown";
  reason: string | null;
  observedAt: string | null;
  checking: boolean;
}
export const PROVIDER_AVAILABILITY: Readonly<Record<string, ProviderAvailability["status"]>>;
export function isProviderRoutable(availability?: ProviderAvailability | null): boolean;

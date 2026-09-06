const PROVIDER_AVAILABILITY = Object.freeze({
  AVAILABLE: "available",
  AUTHENTICATION_REQUIRED: "authentication_required",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown",
});

function isProviderRoutable(availability) {
  return (
    !availability ||
    [PROVIDER_AVAILABILITY.AVAILABLE, PROVIDER_AVAILABILITY.UNKNOWN].includes(availability.status)
  );
}

module.exports = { PROVIDER_AVAILABILITY, isProviderRoutable };

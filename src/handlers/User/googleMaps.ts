import { Request, Response } from "express";

/**
 * Validate address using Google Maps Geocoding API
 * @route POST /api/user/validate-address
 */
export const validateAddress = async (req: Request, res: Response) => {
  try {
    const address = req.body?.address;

    if (typeof address !== "string" || !address.trim()) {
      return res.status(400).json({
        success: false,
        message: "Address is required"
      });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      console.error("❌ GOOGLE_MAPS_API_KEY not configured in backend");
      return res.status(500).json({
        success: false,
        message: "Google Maps service not configured"
      });
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      throw new Error(`Google geocoding request failed (${response.status})`);
    }
    const data = await response.json();

    const isValid = data.status === 'OK' && data.results && data.results.length > 0;
    const result = isValid ? data.results[0] : null;
    const location = result?.geometry?.location;
    const lat = typeof location?.lat === 'number' ? location.lat : undefined;
    const lng = typeof location?.lng === 'number' ? location.lng : undefined;
    const coordinates =
      lat !== undefined && lng !== undefined ? { lat, lng } : null;

    return res.status(200).json({
      success: true,
      isValid,
      coordinates,
      data: result
    });

  } catch (error: any) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error("Address validation error:", timedOut ? "Google request timed out" : error);
    return res.status(500).json({
      success: false,
      message: timedOut ? "Address validation timed out" : "Failed to validate address"
    });
  }
};

/**
 * Get Google Maps API configuration (returns script URL without exposing the key)
 * @route GET /api/public/google-maps-config
 */
export const getGoogleMapsConfig = async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "Google Maps service not configured"
      });
    }

    // Return the script URL with the API key
    // This is a public endpoint for loading the Maps JavaScript library
    res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    return res.status(200).json({
      success: true,
      scriptUrl: `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`
    });

  } catch (error: any) {
    console.error("Google Maps config error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get Google Maps configuration"
    });
  }
};

import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();

// Auth routes (handles OTP verification callbacks)
auth.addHttpRoutes(http);

export default http;

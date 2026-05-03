// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Typed errors for the Ollama HTTP client.
//
// [SEC H-1] These error codes are thrown by the endpoint-validation path
// before any network connection is opened.

/**
 * Thrown when the endpoint URL fails validation before a connection is
 * attempted. Covers parse errors, disallowed protocols, user-info presence,
 * and non-loopback hostnames when `allowRemote` is false.
 *
 * [SEC H-1]
 */
export class RemoteEndpointDisallowedError extends Error {
  readonly code: "REMOTE_DISALLOWED" | "URL_PARSE";

  constructor(
    message: string,
    code: "REMOTE_DISALLOWED" | "URL_PARSE" = "REMOTE_DISALLOWED",
  ) {
    super(message);
    this.name = "RemoteEndpointDisallowedError";
    this.code = code;
  }
}

/**
 * Thrown when the Ollama server returns a non-200 status, a malformed JSON
 * body, a network error, or when the request times out.
 */
export class OllamaError extends Error {
  readonly code: "OLLAMA_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
    this.code = "OLLAMA_ERROR";
  }
}

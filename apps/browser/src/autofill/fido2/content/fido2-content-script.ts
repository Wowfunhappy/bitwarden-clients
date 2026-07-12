import {
  AssertCredentialParams,
  CreateCredentialParams,
} from "@bitwarden/common/platform/abstractions/fido2/fido2-client.service.abstraction";

import { sendExtensionMessage } from "../../../autofill/utils";
import { Fido2PortName } from "../enums/fido2-port-name.enum";

import {
  InsecureAssertCredentialParams,
  InsecureCreateCredentialParams,
  Message,
  MessageType,
} from "./messaging/message";
import { MessageWithMetadata, Messenger } from "./messaging/messenger";

(function (globalContext) {
  const shouldExecuteContentScript =
    globalContext.document.contentType === "text/html" &&
    (globalContext.document.location.protocol === "https:" ||
      (globalContext.document.location.protocol === "http:" &&
        globalContext.document.location.hostname === "localhost"));

  if (!shouldExecuteContentScript) {
    return;
  }

  // Initialization logic, set up the messenger and connect a port to the background script.
  const messenger = Messenger.forDOMCommunication(globalContext.window);
  messenger.handler = handleFido2Message;
  const port = chrome.runtime.connect({ name: Fido2PortName.InjectedScript });
  port.onDisconnect.addListener(handlePortOnDisconnect);

  /**
   * Handles FIDO2 credential requests and returns the result.
   *
   * @param message - The message to handle.
   * @param abortController - The abort controller used to handle exit conditions from the FIDO2 request.
   */
  async function handleFido2Message(
    message: MessageWithMetadata,
    abortController: AbortController,
  ) {
    const requestId = Date.now().toString();
    const abortHandler = () =>
      sendExtensionMessage("fido2AbortRequest", { abortedRequestId: requestId });
    abortController.signal.addEventListener("abort", abortHandler);

    try {
      if (message.type === MessageType.CredentialCreationRequest) {
        return handleCredentialCreationRequestMessage(
          requestId,
          message.data as InsecureCreateCredentialParams,
        );
      }

      if (message.type === MessageType.CredentialGetRequest) {
        return handleCredentialGetRequestMessage(
          requestId,
          message.data as InsecureAssertCredentialParams,
        );
      }

      if (message.type === MessageType.AbortRequest) {
        return sendExtensionMessage("fido2AbortRequest", { abortedRequestId: requestId });
      }
    } finally {
      abortController.signal.removeEventListener("abort", abortHandler);
    }
  }

  /**
   * Handles the credential creation request message and returns the result.
   *
   * @param requestId - The request ID of the message.
   * @param data - Data associated with the credential request.
   */
  async function handleCredentialCreationRequestMessage(
    requestId: string,
    data: InsecureCreateCredentialParams,
  ): Promise<Message | undefined> {
    return respondToCredentialRequest(
      "fido2RegisterCredentialRequest",
      MessageType.CredentialCreationResponse,
      requestId,
      data,
    );
  }

  /**
   * Handles the credential get request message and returns the result.
   *
   * @param requestId - The request ID of the message.
   * @param data - Data associated with the credential request.
   */
  async function handleCredentialGetRequestMessage(
    requestId: string,
    data: InsecureAssertCredentialParams,
  ): Promise<Message | undefined> {
    return respondToCredentialRequest(
      "fido2GetCredentialRequest",
      MessageType.CredentialGetResponse,
      requestId,
      data,
    );
  }

  /**
   * Sends a message to the extension to handle the
   * credential request and returns the result.
   *
   * @param command - The command to send to the extension.
   * @param type - The type of message, either CredentialCreationResponse or CredentialGetResponse.
   * @param requestId - The request ID of the message.
   * @param messageData - Data associated with the credential request.
   */
  async function respondToCredentialRequest(
    command: string,
    type: MessageType.CredentialCreationResponse | MessageType.CredentialGetResponse,
    requestId: string,
    messageData: InsecureCreateCredentialParams | InsecureAssertCredentialParams,
  ): Promise<Message | undefined> {
    const featureName = permissionsPolicyFeatureForCommand(command);
    if (featureName != null && !isWebAuthnFeatureAllowed(featureName)) {
      return Promise.reject(buildPermissionsPolicyError(featureName));
    }

    const data: CreateCredentialParams | AssertCredentialParams = {
      ...messageData,
      origin: globalContext.location.origin,
      sameOriginWithAncestors: globalContext.self === globalContext.top,
    };

    const result = await sendExtensionMessage(command, { data, requestId });

    if (result && result.error !== undefined) {
      return Promise.reject(result.error);
    }

    return Promise.resolve({ type, result });
  }

  // Backport of upstream bitwarden/clients #21054 (PM-37768, "VULN - webauthn honor
  // permissions policy"): only allow a WebAuthn ceremony when the document's
  // Permissions Policy grants it. Runs in the isolated content-script world so its
  // view of the policy and self/top cannot be tampered with by page script.
  function permissionsPolicyFeatureForCommand(command: string): string | undefined {
    if (command === "fido2RegisterCredentialRequest") {
      return "publickey-credentials-create";
    }
    if (command === "fido2GetCredentialRequest") {
      return "publickey-credentials-get";
    }
    return undefined;
  }

  // Prefers the standardized document.permissionsPolicy, falls back to the older
  // document.featurePolicy. When neither exists (this WebKit, default Firefox), fall
  // back to a defense-in-depth check: the spec default allowlist for
  // publickey-credentials-* is `self`, so deny cross-origin iframes. This over-rejects
  // iframes that legitimately received an allow= delegation, which we can't read
  // without the policy API — the safe direction to err.
  function isWebAuthnFeatureAllowed(featureName: string): boolean {
    try {
      const policyHolder = globalContext.document as Document & {
        permissionsPolicy?: { allowsFeature(feature: string): boolean };
        featurePolicy?: { allowsFeature(feature: string): boolean };
      };
      const policy = policyHolder.permissionsPolicy ?? policyHolder.featurePolicy;
      if (policy != null && typeof policy.allowsFeature === "function") {
        return policy.allowsFeature(featureName);
      }
    } catch {
      // Fall through to the defense-in-depth check.
    }

    return !isCrossOriginIframe();
  }

  function isCrossOriginIframe(): boolean {
    try {
      if (globalContext.self === globalContext.top) {
        return false;
      }
      return globalContext.top?.location.origin !== globalContext.self.location.origin;
    } catch {
      // SecurityError reading top.location → top is a different origin.
      return true;
    }
  }

  function buildPermissionsPolicyError(featureName: string): DOMException {
    return new DOMException(
      `The '${featureName}' feature is not enabled in this document. Permissions Policy may be used to delegate Web Authentication capabilities to cross-origin child frames.`,
      "NotAllowedError",
    );
  }

  /**
   * Handles the disconnect event of the port. Calls
   * to the messenger to destroy and tear down the
   * implemented page-script.js logic.
   */
  function handlePortOnDisconnect() {
    void messenger.destroy();
  }
})(globalThis);

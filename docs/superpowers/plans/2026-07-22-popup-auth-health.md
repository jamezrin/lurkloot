# Popup Authentication Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make popup status surfaces distinguish healthy automation from authentication checking, sign-in requirements, security-policy blocking, and temporary unavailability while preserving the user's automation toggle.

**Architecture:** A pure `automationStatus` module maps settings and normalized `PlatformAuthHealth` into a typed presentation model. `Popup` derives one model per platform and passes it to the existing header, switcher, and hero; rendering never consumes raw credentials or errors. Existing five-second snapshot refreshes provide automatic recovery with no new transport or polling mechanism.

**Tech Stack:** TypeScript 7, React 19, Vitest 4, linkedom, Tailwind CSS, pnpm workspace packages.

## Global Constraints

- Work only in `.worktrees/popup-auth-health` on `feat/popup-auth-health`.
- Running appears only when the platform is enabled and authenticated.
- Missing and rejected credentials use explicit first-party sign-in buttons: `https://www.twitch.tv/login` and `https://kick.com/`.
- Kick security-policy blocking must say the browser profile was rejected and must not offer sign-in as the fix.
- Degraded authentication must not disable or change the platform automation setting.
- Do not render credentials, raw errors, authenticated response bodies, or optional auth message values.
- Add no popup authentication polling; consume the existing runtime snapshot refresh.
- Every new user-facing key must exist with a genuine translation in all eleven locale catalogs.

---

## File Structure

- Create `packages/popup-ui/src/automationStatus.ts`: pure status derivation, fixed sign-in URLs, and exhaustive presentation types.
- Create `packages/extension/tests/automationStatus.test.ts`: unit coverage for precedence, every auth state/reason, action mapping, and sensitive-value omission.
- Modify `packages/popup-ui/src/automation.tsx`: render the derived status in the hero and platform switcher.
- Create `packages/extension/tests/automationView.test.tsx`: focused component coverage for badge, copy, action click, visual indicator, and toggle availability.
- Modify `packages/popup-ui/src/Popup.tsx`: derive platform presentations and share them across header, switcher, and hero.
- Create `packages/extension/tests/popupAuthHealth.test.tsx`: integration coverage for header consistency and snapshot-driven recovery.
- Modify `packages/popup-ui/src/primitives.tsx`: add an amber `warning` pill tone.
- Modify `packages/locales/messages/{ar,de,en,es,fr,hi,it,pt_BR,ru,tr,zh_CN}.json`: complete auth-health UI copy.
- Modify `packages/extension/tests/i18n.test.ts`: pin English wording and require all auth UI keys in every catalog.

---

### Task 1: Pure Authentication Presentation Model

**Files:**
- Create: `packages/popup-ui/src/automationStatus.ts`
- Create: `packages/extension/tests/automationStatus.test.ts`

**Interfaces:**
- Consumes: `Platform`, `PlatformAuthHealth`, and `PlatformAuthReasonCode` from `@lurkloot/shared/models`.
- Produces: `AutomationPresentation`, `AutomationPresentationState`, `AUTH_SIGN_IN_URLS`, and `automationPresentation(input)`.

- [ ] **Step 1: Write the failing presentation tests**

Create `packages/extension/tests/automationStatus.test.ts` with table-driven tests equivalent to:

```ts
import { describe, expect, it } from "vitest";
import type { PlatformAuthHealth } from "@lurkloot/shared/models";
import { AUTH_SIGN_IN_URLS, automationPresentation } from "../../popup-ui/src/automationStatus";

const health = (status: PlatformAuthHealth["status"], reasonCode?: PlatformAuthHealth["reasonCode"]): PlatformAuthHealth => ({
  status,
  reasonCode,
  message: { key: status === "blocked" ? "authSecurityPolicyBlocked" : "authPlatformUnavailable", values: { reference: "must-not-render" } },
});

describe("automation authentication presentation", () => {
  it("gives pending and paused states precedence", () => {
    expect(automationPresentation({ platform: "twitch", enabled: true, pending: true, authHealth: health("missing_credentials") }).state).toBe("starting");
    expect(automationPresentation({ platform: "twitch", enabled: false, pending: true, authHealth: health("healthy") }).state).toBe("stopping");
    expect(automationPresentation({ platform: "kick", enabled: false, pending: false, authHealth: health("blocked") }).state).toBe("paused");
  });

  it.each([
    ["healthy", undefined, "running", "automationRunning", "accent", undefined],
    ["checking", undefined, "checking", "automationChecking", "muted", "authCheckingDetail"],
    ["missing_credentials", "credentials_missing", "needs_sign_in", "automationNeedsSignIn", "warning", "authSignInMissing"],
    ["invalid_credentials", "credentials_rejected", "needs_sign_in", "automationNeedsSignIn", "warning", "authSignInRejected"],
    ["blocked", "security_policy_blocked", "blocked", "automationBlocked", "danger", "authBrowserProfileBlocked"],
    ["unavailable", "credential_lookup_failed", "unavailable", "automationUnavailable", "warning", "authCredentialCheckUnavailable"],
    ["unavailable", "network_unavailable", "unavailable", "automationUnavailable", "warning", "authNetworkTemporarilyUnavailable"],
    ["unavailable", "platform_unavailable", "unavailable", "automationUnavailable", "warning", "authPlatformTemporarilyUnavailable"],
  ] as const)("maps %s/%s", (status, reasonCode, state, badgeKey, tone, detailKey) => {
    expect(automationPresentation({ platform: "kick", enabled: true, pending: false, authHealth: health(status, reasonCode) })).toMatchObject({ state, badgeKey, tone, detailKey });
  });

  it.each(["missing_credentials", "invalid_credentials"] as const)("provides fixed sign-in actions for %s", (status) => {
    expect(automationPresentation({ platform: "twitch", enabled: true, pending: false, authHealth: health(status) }).action).toEqual({ labelKey: "signInToTwitch", url: AUTH_SIGN_IN_URLS.twitch });
    expect(automationPresentation({ platform: "kick", enabled: true, pending: false, authHealth: health(status) }).action).toEqual({ labelKey: "signInToKick", url: AUTH_SIGN_IN_URLS.kick });
  });

  it.each(["checking", "healthy", "blocked", "unavailable"] as const)("does not offer sign-in for %s", (status) => {
    expect(automationPresentation({ platform: "kick", enabled: true, pending: false, authHealth: health(status) }).action).toBeUndefined();
  });

  it("does not propagate auth message values", () => {
    expect(JSON.stringify(automationPresentation({ platform: "kick", enabled: true, pending: false, authHealth: health("blocked", "security_policy_blocked") }))).not.toContain("must-not-render");
  });
});
```

- [ ] **Step 2: Run the unit test and confirm the module is missing**

Run: `pnpm --filter @lurkloot/extension test -- automationStatus.test.ts`

Expected: FAIL because `../../popup-ui/src/automationStatus` does not exist.

- [ ] **Step 3: Implement the exhaustive pure mapper**

Create `packages/popup-ui/src/automationStatus.ts` with these public types and constants:

```ts
import type { Platform, PlatformAuthHealth } from "@lurkloot/shared/models";

export type AutomationPresentationState = "starting" | "stopping" | "paused" | "running" | "checking" | "needs_sign_in" | "blocked" | "unavailable";
export type AutomationTone = "muted" | "accent" | "warning" | "danger";
export interface AutomationPresentation {
  state: AutomationPresentationState;
  badgeKey: string;
  detailKey?: string;
  tone: AutomationTone;
  operational: boolean;
  action?: { labelKey: "signInToTwitch" | "signInToKick"; url: string };
}
export const AUTH_SIGN_IN_URLS: Record<Platform, string> = {
  twitch: "https://www.twitch.tv/login",
  kick: "https://kick.com/",
};
export function automationPresentation(input: { platform: Platform; enabled: boolean; pending: boolean; authHealth: PlatformAuthHealth }): AutomationPresentation;
```

Implement priority as pending → paused → auth status. Starting uses `{ badgeKey: "automationStarting", detailKey: "startingAutomation", tone: "muted", operational: false }`; stopping uses the corresponding existing `automationStopping`/`pausingAutomation` keys; paused uses `pausedStatus`/`watchingPausedHint`. Use a `switch` over all six `PlatformAuthStatus` values. For `unavailable`, map `credential_lookup_failed`, `network_unavailable`, and the fallback `platform_unavailable` to their exact detail keys from Step 1. Construct the action only for missing/rejected credentials. Never copy `authHealth.message`, `checkedAt`, or message values into the return object.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm --filter @lurkloot/extension test -- automationStatus.test.ts`

Expected: PASS with all presentation cases green.

- [ ] **Step 5: Commit the pure model**

```bash
git add packages/popup-ui/src/automationStatus.ts packages/extension/tests/automationStatus.test.ts
git commit -m "feat(popup): derive authentication status presentation"
```

---

### Task 2: Render Hero and Switcher Authentication States

**Files:**
- Modify: `packages/popup-ui/src/primitives.tsx:41-50`
- Modify: `packages/popup-ui/src/automation.tsx:1-88`
- Create: `packages/extension/tests/automationView.test.tsx`

**Interfaces:**
- Consumes: `AutomationPresentation` from Task 1, `PopupAdapter.openLink`, and the existing `I18nContext`/`PopupRuntimeContext`.
- Produces: `PlatformSwitcher` accepting `presentation: Record<Platform, AutomationPresentation>` and `AutomationHero` accepting one `presentation` plus the existing content/toggle props.

- [ ] **Step 1: Write failing component tests**

Create a linkedom mount helper in `automationView.test.tsx` following `dropsView.test.tsx`: install DOM globals, render both components inside `I18nContext` and `PopupRuntimeContext`, and unmount in `afterEach`. Use a translator that maps the new keys to readable English.

Assert these exact behaviors:

```ts
expect(container.textContent).toContain("Needs sign-in");
expect(container.textContent).toContain("Sign in to Twitch");
expect(container.querySelector('[data-auth-action="twitch"]')).not.toBeNull();
act(() => container.querySelector<HTMLButtonElement>('[data-auth-action="twitch"]')?.click());
expect(openLink).toHaveBeenCalledWith("https://www.twitch.tv/login");

expect(container.querySelector('[role="switch"]')?.hasAttribute("disabled")).toBe(false);
expect(container.querySelector('[data-automation-state="blocked"]')).not.toBeNull();
expect(container.textContent).toContain("Kick rejected this browser profile");
expect(container.querySelector("[data-auth-action]")).toBeNull();

expect(container.querySelector('[data-platform-status="twitch"]')?.getAttribute("data-state")).toBe("running");
expect(container.querySelector('[data-platform-status="kick"]')?.getAttribute("data-state")).toBe("unavailable");
```

Also rerender a healthy hero with a `farmingChannel` and verify watching/farming detail is shown only for `presentation.state === "running"`; degraded states must show `detailKey` even if stale farming props are supplied.

- [ ] **Step 2: Run the component test and confirm prop/render failures**

Run: `pnpm --filter @lurkloot/extension test -- automationView.test.tsx`

Expected: FAIL because the components do not accept or render `presentation`.

- [ ] **Step 3: Add the warning pill tone**

Extend the `Pill` tone union in `primitives.tsx` with `warning` and add:

```ts
warning: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
```

- [ ] **Step 4: Update the switcher contract and indicators**

Change `PlatformSwitcher` to accept:

```ts
export function PlatformSwitcher({ active, presentation, onChange }: {
  active: Platform;
  presentation: Record<Platform, AutomationPresentation>;
  onChange(platform: Platform): void;
})
```

For each platform, set `data-platform-status={id}` and `data-state={status.state}`. Use the accent-filled/glowing dot only when `status.operational` is true, an amber dot for `needs_sign_in`/`unavailable`, red for `blocked`, and the existing outlined neutral dot otherwise. Localize the button title from the presentation badge rather than interpolating hard-coded English.

- [ ] **Step 5: Update the hero contract and degraded rendering**

Change `AutomationHero` to accept `platform`, `enabled`, `pending`, and `presentation`. Put `data-automation-state={presentation.state}` on its root. Render `t(presentation.badgeKey)` with `Pill tone={presentation.tone}`. Apply glow/accent icon styling only when `presentation.operational` is true.

Keep the existing pending and paused detail branches. Render watching/farming details only for `running`. For all other enabled states render `t(presentation.detailKey!)`; when `presentation.action` exists, add:

```tsx
<button
  type="button"
  data-auth-action={platform}
  onClick={() => runtime?.adapter.openLink(presentation.action!.url)}
  className="mt-1 w-fit rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--accent-text)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
>
  {t(presentation.action.labelKey)}
</button>
```

Use `usePopupRuntime()` (or the existing context access pattern) to obtain the adapter. Keep `Toggle disabled={pending}` exactly so degraded states remain interactive.

- [ ] **Step 6: Run component and pure tests**

Run: `pnpm --filter @lurkloot/extension test -- automationView.test.tsx automationStatus.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit component rendering**

```bash
git add packages/popup-ui/src/primitives.tsx packages/popup-ui/src/automation.tsx packages/extension/tests/automationView.test.tsx
git commit -m "feat(popup): render authentication health actions"
```

---

### Task 3: Integrate Consistent Popup Status and Recovery

**Files:**
- Modify: `packages/popup-ui/src/Popup.tsx:476-512,538-543,592`
- Create: `packages/extension/tests/popupAuthHealth.test.tsx`

**Interfaces:**
- Consumes: `automationPresentation` and the component contracts from Tasks 1–2.
- Produces: consistent header, switcher, and hero status derived from `snapshot.state.authHealth`.

- [ ] **Step 1: Write the failing popup integration tests**

Create `popupAuthHealth.test.tsx` with the same linkedom/React setup as other popup integration tests. Build snapshots from `demoSnapshot()` with `settings.running = true`, both platform settings enabled, empty/stale sessions, and controlled `authHealth`. Make `adapter.send({ type: "getSnapshot" })` return queued snapshots and use fake timers for the existing 5,000 ms refresh.

Test initial degraded consistency:

```ts
expect(container.querySelector('[data-automation-state="needs_sign_in"]')).not.toBeNull();
expect(container.textContent).toContain("Needs sign-in · Twitch");
expect(container.querySelector('[data-platform-status="twitch"]')?.getAttribute("data-state")).toBe("needs_sign_in");
expect(container.textContent).not.toContain("Farming stale campaign");
```

Test recovery without settings mutation:

```ts
await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); });
expect(container.querySelector('[data-automation-state="running"]')).not.toBeNull();
expect(container.textContent).toContain("Running · Twitch");
expect(adapter.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setAutomation" }));
```

Test blocked Kick with a hostile safe-reference value and assert neither that value nor any stale session message appears in `container.textContent`.

- [ ] **Step 2: Run the integration test and confirm it fails**

Run: `pnpm --filter @lurkloot/extension test -- popupAuthHealth.test.tsx`

Expected: FAIL because `Popup` still derives status from automation booleans.

- [ ] **Step 3: Derive one presentation per platform in Popup**

Immediately after `automation`, derive:

```ts
const automationPresentationByPlatform = Object.fromEntries(
  (Object.keys(PLATFORMS) as Platform[]).map((id) => [id, automationPresentation({
    platform: id,
    enabled: automation[id],
    pending: pendingAutomation[id] != null,
    authHealth: snapshot.state.authHealth[id],
  })]),
) as Record<Platform, AutomationPresentation>;
const presentation = automationPresentationByPlatform[platform];
```

Import the mapper and type from `automationStatus.ts`.

- [ ] **Step 4: Wire all three status surfaces to the presentation**

Replace the header dot and label checks with `presentation.operational`, the state-specific indicator color, and `${t(presentation.badgeKey)} · ${PLATFORMS[platform].label}`. Pass `presentation={automationPresentationByPlatform}` to `PlatformSwitcher`. Pass `platform` and `presentation` to `AutomationHero` while retaining `enabled`, `pending`, content, and toggle props.

- [ ] **Step 5: Run integration and component tests**

Run: `pnpm --filter @lurkloot/extension test -- popupAuthHealth.test.tsx automationView.test.tsx automationStatus.test.ts`

Expected: PASS, including degraded-to-healthy recovery after the existing refresh interval.

- [ ] **Step 6: Commit popup integration**

```bash
git add packages/popup-ui/src/Popup.tsx packages/extension/tests/popupAuthHealth.test.tsx
git commit -m "feat(popup): synchronize authentication health status"
```

---

### Task 4: Localize Authentication Health UI

**Files:**
- Modify: `packages/locales/messages/ar.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/tr.json`
- Modify: `packages/locales/messages/zh_CN.json`
- Modify: `packages/extension/tests/i18n.test.ts`

**Interfaces:**
- Consumes: the exact message keys emitted by `automationStatus.ts`.
- Produces: complete localized copy for all popup auth states and actions.

- [ ] **Step 1: Add failing catalog assertions**

Add an i18n test with this exact English contract:

```ts
const authUiEnglish = {
  automationChecking: "Checking",
  automationNeedsSignIn: "Needs sign-in",
  automationBlocked: "Blocked",
  automationUnavailable: "Unavailable",
  authCheckingDetail: "Checking your signed-in session…",
  authSignInMissing: "Sign in to continue farming drops.",
  authSignInRejected: "Your session is no longer valid. Sign in again to continue.",
  signInToTwitch: "Sign in to Twitch",
  signInToKick: "Sign in to Kick",
  authBrowserProfileBlocked: "Kick rejected this browser profile. Signing in alone may not resolve it.",
  authCredentialCheckUnavailable: "Your browser session could not be checked. Lurkloot will retry automatically.",
  authNetworkTemporarilyUnavailable: "The network is temporarily unavailable. Lurkloot will retry automatically.",
  authPlatformTemporarilyUnavailable: "The platform is temporarily unavailable. Lurkloot will retry automatically.",
};
```

Assert the English messages equal this object and each key is a non-empty string in every catalog. The existing catalog parity and unchanged-English tests remain enabled.

- [ ] **Step 2: Run i18n tests and confirm missing keys**

Run: `pnpm --filter @lurkloot/extension test -- i18n.test.ts`

Expected: FAIL because the thirteen keys are absent.

- [ ] **Step 3: Add English and genuine translations to every catalog**

Add the thirteen keys from Step 1 to `en.json`. Add natural translations carrying the same meaning to all ten non-English catalogs. Keep brand names `Twitch`, `Kick`, and `Lurkloot` unchanged. In particular, each `authBrowserProfileBlocked` translation must preserve both claims: Kick rejected the browser profile, and signing in alone may not fix it. Each unavailable translation must say Lurkloot retries automatically.

Use these reviewed translations in key order (`automationChecking`, `automationNeedsSignIn`, `automationBlocked`, `automationUnavailable`, `authCheckingDetail`, `authSignInMissing`, `authSignInRejected`, `signInToTwitch`, `signInToKick`, `authBrowserProfileBlocked`, `authCredentialCheckUnavailable`, `authNetworkTemporarilyUnavailable`, `authPlatformTemporarilyUnavailable`):

- `es`: “Comprobando”; “Necesita iniciar sesión”; “Bloqueado”; “No disponible”; “Comprobando tu sesión iniciada…”; “Inicia sesión para seguir consiguiendo drops.”; “Tu sesión ya no es válida. Vuelve a iniciar sesión para continuar.”; “Iniciar sesión en Twitch”; “Iniciar sesión en Kick”; “Kick rechazó este perfil del navegador. Puede que iniciar sesión no sea suficiente para resolverlo.”; “No se pudo comprobar la sesión del navegador. Lurkloot volverá a intentarlo automáticamente.”; “La red no está disponible temporalmente. Lurkloot volverá a intentarlo automáticamente.”; “La plataforma no está disponible temporalmente. Lurkloot volverá a intentarlo automáticamente.”
- `de`: “Wird geprüft”; “Anmeldung erforderlich”; “Blockiert”; “Nicht verfügbar”; “Deine angemeldete Sitzung wird geprüft…”; “Melde dich an, um weiter Drops zu farmen.”; “Deine Sitzung ist nicht mehr gültig. Melde dich erneut an, um fortzufahren.”; “Bei Twitch anmelden”; “Bei Kick anmelden”; “Kick hat dieses Browserprofil abgelehnt. Eine Anmeldung allein behebt das Problem möglicherweise nicht.”; “Deine Browsersitzung konnte nicht geprüft werden. Lurkloot versucht es automatisch erneut.”; “Das Netzwerk ist vorübergehend nicht verfügbar. Lurkloot versucht es automatisch erneut.”; “Die Plattform ist vorübergehend nicht verfügbar. Lurkloot versucht es automatisch erneut.”
- `fr`: “Vérification”; “Connexion requise”; “Bloqué”; “Indisponible”; “Vérification de votre session connectée…”; “Connectez-vous pour continuer à récupérer des drops.”; “Votre session n’est plus valide. Reconnectez-vous pour continuer.”; “Se connecter à Twitch”; “Se connecter à Kick”; “Kick a rejeté ce profil de navigateur. Se reconnecter uniquement ne suffira peut-être pas.”; “Votre session de navigateur n’a pas pu être vérifiée. Lurkloot réessaiera automatiquement.”; “Le réseau est temporairement indisponible. Lurkloot réessaiera automatiquement.”; “La plateforme est temporairement indisponible. Lurkloot réessaiera automatiquement.”
- `it`: “Verifica”; “Accesso necessario”; “Bloccato”; “Non disponibile”; “Verifica della sessione connessa…”; “Accedi per continuare a ottenere drop.”; “La sessione non è più valida. Accedi di nuovo per continuare.”; “Accedi a Twitch”; “Accedi a Kick”; “Kick ha rifiutato questo profilo del browser. Il solo accesso potrebbe non risolvere il problema.”; “Non è stato possibile verificare la sessione del browser. Lurkloot riproverà automaticamente.”; “La rete è temporaneamente non disponibile. Lurkloot riproverà automaticamente.”; “La piattaforma è temporaneamente non disponibile. Lurkloot riproverà automaticamente.”
- `pt_BR`: “Verificando”; “Login necessário”; “Bloqueado”; “Indisponível”; “Verificando sua sessão conectada…”; “Entre na sua conta para continuar coletando drops.”; “Sua sessão não é mais válida. Entre novamente para continuar.”; “Entrar na Twitch”; “Entrar na Kick”; “A Kick rejeitou este perfil do navegador. Apenas entrar na conta pode não resolver o problema.”; “Não foi possível verificar a sessão do navegador. O Lurkloot tentará novamente automaticamente.”; “A rede está temporariamente indisponível. O Lurkloot tentará novamente automaticamente.”; “A plataforma está temporariamente indisponível. O Lurkloot tentará novamente automaticamente.”
- `ru`: “Проверка”; “Требуется вход”; “Заблокировано”; “Недоступно”; “Проверяем активный сеанс…”; “Войдите, чтобы продолжить получать награды.”; “Сеанс больше недействителен. Войдите снова, чтобы продолжить.”; “Войти в Twitch”; “Войти в Kick”; “Kick отклонил этот профиль браузера. Одного входа может быть недостаточно для решения проблемы.”; “Не удалось проверить сеанс браузера. Lurkloot повторит попытку автоматически.”; “Сеть временно недоступна. Lurkloot повторит попытку автоматически.”; “Платформа временно недоступна. Lurkloot повторит попытку автоматически.”
- `tr`: “Kontrol ediliyor”; “Oturum açılmalı”; “Engellendi”; “Kullanılamıyor”; “Oturumunuz kontrol ediliyor…”; “Drop toplamaya devam etmek için oturum açın.”; “Oturumunuz artık geçerli değil. Devam etmek için yeniden oturum açın.”; “Twitch'te oturum aç”; “Kick'te oturum aç”; “Kick bu tarayıcı profilini reddetti. Yalnızca oturum açmak sorunu çözmeyebilir.”; “Tarayıcı oturumunuz kontrol edilemedi. Lurkloot otomatik olarak yeniden deneyecek.”; “Ağ geçici olarak kullanılamıyor. Lurkloot otomatik olarak yeniden deneyecek.”; “Platform geçici olarak kullanılamıyor. Lurkloot otomatik olarak yeniden deneyecek.”
- `zh_CN`: “正在检查”; “需要登录”; “已阻止”; “暂时不可用”; “正在检查你的登录会话…”; “请登录以继续获取掉宝。”; “你的会话已失效。请重新登录以继续。”; “登录 Twitch”; “登录 Kick”; “Kick 拒绝了此浏览器配置文件。仅重新登录可能无法解决问题。”; “无法检查浏览器会话。Lurkloot 将自动重试。”; “网络暂时不可用。Lurkloot 将自动重试。”; “平台暂时不可用。Lurkloot 将自动重试。”
- `hi`: “जाँच जारी है”; “साइन इन आवश्यक”; “अवरुद्ध”; “अनुपलब्ध”; “आपके साइन-इन सत्र की जाँच हो रही है…”; “ड्रॉप पाना जारी रखने के लिए साइन इन करें।”; “आपका सत्र अब मान्य नहीं है। जारी रखने के लिए फिर से साइन इन करें।”; “Twitch में साइन इन करें”; “Kick में साइन इन करें”; “Kick ने इस ब्राउज़र प्रोफ़ाइल को अस्वीकार कर दिया। केवल साइन इन करने से समस्या हल न हो सके।”; “आपके ब्राउज़र सत्र की जाँच नहीं हो सकी। Lurkloot अपने आप फिर प्रयास करेगा।”; “नेटवर्क अस्थायी रूप से अनुपलब्ध है। Lurkloot अपने आप फिर प्रयास करेगा।”; “प्लेटफ़ॉर्म अस्थायी रूप से अनुपलब्ध है। Lurkloot अपने आप फिर प्रयास करेगा।”
- `ar`: “جارٍ التحقق”; “يلزم تسجيل الدخول”; “محظور”; “غير متاح”; “جارٍ التحقق من جلسة تسجيل دخولك…”; “سجّل الدخول لمواصلة جمع المكافآت.”; “لم تعد جلستك صالحة. سجّل الدخول مجددًا للمتابعة.”; “تسجيل الدخول إلى Twitch”; “تسجيل الدخول إلى Kick”; “رفض Kick ملف تعريف المتصفح هذا. قد لا يكفي تسجيل الدخول وحده لحل المشكلة.”; “تعذر التحقق من جلسة المتصفح. سيعيد Lurkloot المحاولة تلقائيًا.”; “الشبكة غير متاحة مؤقتًا. سيعيد Lurkloot المحاولة تلقائيًا.”; “المنصة غير متاحة مؤقتًا. سيعيد Lurkloot المحاولة تلقائيًا.”

After editing, validate JSON mechanically:

```bash
node -e 'for (const f of require("fs").readdirSync("packages/locales/messages")) JSON.parse(require("fs").readFileSync(`packages/locales/messages/${f}`, "utf8"))'
```

Expected: exit 0 with no output.

- [ ] **Step 4: Run localization and popup tests**

Run: `pnpm --filter @lurkloot/extension test -- i18n.test.ts automationStatus.test.ts automationView.test.tsx popupAuthHealth.test.tsx`

Expected: PASS with catalog parity and unchanged-English checks green.

- [ ] **Step 5: Commit translations**

```bash
git add packages/locales/messages packages/extension/tests/i18n.test.ts
git commit -m "feat(locales): translate authentication health guidance"
```

---

### Task 5: Full Verification and Final Review

**Files:**
- Review only: all files changed by Tasks 1–4.

**Interfaces:**
- Consumes: complete implementation.
- Produces: verified issue #205 acceptance criteria with no uncommitted fixes.

- [ ] **Step 1: Run formatting and diff hygiene checks**

Run: `git diff origin/develop --check && git status --short`

Expected: no whitespace errors; only intentional committed branch changes are listed by the comparison, and the worktree itself is clean.

- [ ] **Step 2: Run the repository check suite**

Run: `pnpm check`

Expected: script tests, all workspace typechecks, extension tests, and Astro site build pass.

- [ ] **Step 3: Build both extension targets**

Run: `pnpm build && pnpm build:firefox`

Expected: Chromium and Firefox WXT production builds complete successfully.

- [ ] **Step 4: Inspect the final diff for safety and scope**

Run:

```bash
git diff --stat origin/develop...HEAD
git diff origin/develop...HEAD -- packages/popup-ui/src packages/locales/messages packages/extension/tests
```

Confirm the diff contains no credential fields, raw errors, response payload rendering, new permissions, auth polling, or automation-setting mutation caused by health changes.

- [ ] **Step 5: Commit any verification-only correction, if required**

If verification required a code correction, repeat its focused test and `pnpm check`, then commit only that correction with a scoped Conventional Commit. If no correction was required, do not create an empty commit.

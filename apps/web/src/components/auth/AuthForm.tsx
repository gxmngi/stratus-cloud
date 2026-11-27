"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Loader2,
  ArrowUpRight,
  AlertCircle,
} from "lucide-react";
import { ApiError, authApi } from "@/lib/api";
import { useAuth } from "./AuthProvider";
import { SessionScreen } from "./SessionScreen";
import { Brand } from "../Brand";
import { Cloudscape, CloudscapeCredit } from "../Cloudscape";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const register = mode === "register";
  const router = useRouter();
  const { status, acceptUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>(
    {},
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const busy = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [router, status]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [cooldown]);

  const validateEmail = () =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    email.trim().length <= 254
      ? undefined
      : "Enter a valid email address.";
  const validatePassword = () =>
    !password
      ? "Enter your password."
      : password.length > 128
        ? "Use no more than 128 characters."
        : register && password.length < 15
          ? "Use at least 15 characters for your password."
          : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || cooldown > 0) return;
    const nextErrors = { email: validateEmail(), password: validatePassword() };
    setErrors(nextErrors);
    setError("");
    if (nextErrors.email || nextErrors.password) {
      (nextErrors.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      if (register) {
        await authApi.register(email.trim(), password);
        setPassword("");
        setCreated(true);
      } else {
        const response = await authApi.login(email.trim(), password);
        setPassword("");
        acceptUser(response.user);
        router.replace("/");
      }
    } catch (failure) {
      if (failure instanceof ApiError) {
        if (failure.status === 401)
          setError("The email or password isn’t correct. Please try again.");
        else if (failure.status === 409)
          setError(
            "An account with this email may already exist. Try signing in instead.",
          );
        else if (failure.status === 429) {
          const seconds = Number(failure.retryAfter);
          setCooldown(
            Number.isFinite(seconds) && seconds > 0
              ? Math.min(Math.ceil(seconds), 900)
              : 60,
          );
          setError("Too many attempts. Please wait before trying again.");
        } else if (failure.status === 400) setError(failure.message);
        else
          setError(
            "We couldn’t complete your request. Please try again in a moment.",
          );
      } else
        setError(
          "We couldn’t reach Stratus. Check your connection and try again.",
        );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (status !== "anonymous") return <SessionScreen />;

  return (
    <div className="auth-page">
      <a className="auth-skip" href="#auth-form">
        Skip to {register ? "registration" : "sign in"}
      </a>
      <aside className="auth-story" aria-label="About Stratus">
        <Cloudscape />
        <Brand />
        <div className="auth-story-content">
          <h2>From commit<br />to production.</h2>
          <p>Build, preview, and deploy on your own infrastructure.</p>
        </div>
        <CloudscapeCredit />
      </aside>

      <main className="auth-main" id="auth-form">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-wrap">
          {created ? (
            <div className="auth-success" role="status">
              <span className="auth-success-icon">
                <Check size={28} aria-hidden="true" />
              </span>
              <span className="auth-form-eyebrow">Account created</span>
              <h1>
                Your workspace
                <br />
                is one sign-in away.
              </h1>
              <p>
                Your account for <strong>{email.trim()}</strong> is ready. Sign
                in to start your first deployment.
              </p>
              <Link href="/login" className="auth-submit">
                Continue to sign in <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <>
              <div className="auth-form-heading">
                <h1>{register ? "Start building." : "Welcome back."}</h1>
                <p>
                  {register
                    ? "Create a Stratus account to deploy your projects."
                    : "Sign in to your Stratus workspace."}
                </p>
              </div>
              <form
                onSubmit={submit}
                noValidate
                aria-label={register ? "Create account" : "Sign in"}
                aria-busy={pending}
              >
                {error && (
                  <div
                    className="auth-error-summary"
                    role="alert"
                    tabIndex={-1}
                    ref={errorRef}
                  >
                    <AlertCircle size={17} aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )}
                <div className="auth-field">
                  <label htmlFor="email">Email address</label>
                  <input
                    ref={emailRef}
                    id="email"
                    name="email"
                    type="email"
                    autoComplete={register ? "email" : "username"}
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    maxLength={254}
                    placeholder="you@example.com"
                    value={email}
                    disabled={pending}
                    aria-invalid={!!errors.email}
                    aria-describedby={errors.email ? "email-error" : undefined}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setErrors((previous) => ({
                        ...previous,
                        email: undefined,
                      }));
                    }}
                    onBlur={() =>
                      setErrors((previous) => ({
                        ...previous,
                        email: email ? validateEmail() : undefined,
                      }))
                    }
                  />
                  {errors.email && (
                    <p className="auth-field-error" id="email-error">
                      {errors.email}
                    </p>
                  )}
                </div>
                <div className="auth-field">
                  <label htmlFor="password">Password</label>
                  <div className="auth-password-wrap">
                    <input
                      ref={passwordRef}
                      id="password"
                      name="password"
                      type={visible ? "text" : "password"}
                      autoComplete={
                        register ? "new-password" : "current-password"
                      }
                      required
                      minLength={register ? 15 : undefined}
                      maxLength={128}
                      placeholder={
                        register
                          ? "Create a strong passphrase"
                          : "Enter your password"
                      }
                      value={password}
                      disabled={pending}
                      aria-invalid={!!errors.password}
                      aria-describedby={
                        [
                          errors.password ? "password-error" : "",
                          register ? "password-hint" : "",
                          capsLock ? "caps-lock" : "",
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setErrors((previous) => ({
                          ...previous,
                          password: undefined,
                        }));
                      }}
                      onKeyDown={(event) =>
                        setCapsLock(event.getModifierState("CapsLock"))
                      }
                      onKeyUp={(event) =>
                        setCapsLock(event.getModifierState("CapsLock"))
                      }
                      onBlur={() => {
                        setCapsLock(false);
                        setErrors((previous) => ({
                          ...previous,
                          password: password ? validatePassword() : undefined,
                        }));
                      }}
                    />
                    <button
                      className="auth-reveal"
                      type="button"
                      onClick={() => setVisible((value) => !value)}
                      aria-label={visible ? "Hide password" : "Show password"}
                      aria-pressed={visible}
                      disabled={pending}
                    >
                      {visible ? (
                        <EyeOff size={18} aria-hidden="true" />
                      ) : (
                        <Eye size={18} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  {errors.password && (
                    <p className="auth-field-error" id="password-error">
                      {errors.password}
                    </p>
                  )}
                  {register && (
                    <p className="auth-field-hint" id="password-hint">
                      Use 15–128 characters. A memorable passphrase works well.
                    </p>
                  )}
                  {capsLock && (
                    <p className="auth-caps" id="caps-lock" role="status">
                      Caps Lock is on.
                    </p>
                  )}
                </div>
                <button
                  className="auth-submit"
                  type="submit"
                  disabled={pending || cooldown > 0}
                >
                  {pending ? (
                    <>
                      <Loader2
                        size={18}
                        className="auth-spin"
                        aria-hidden="true"
                      />
                      {register ? "Creating account…" : "Signing in…"}
                    </>
                  ) : cooldown > 0 ? (
                    `Try again in ${cooldown}s`
                  ) : (
                    <>
                      {register ? "Create account" : "Sign in"}
                      <ArrowRight size={18} aria-hidden="true" />
                    </>
                  )}
                </button>
                <p className="auth-cooldown" role="status">
                  {cooldown > 0
                    ? "You can try again when the waiting period ends."
                    : ""}
                </p>
              </form>
              <p className="auth-switch">
                {register ? "Already have an account?" : "New to Stratus?"}{" "}
                <Link href={register ? "/login" : "/register"}>
                  {register ? "Sign in" : "Create an account"}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

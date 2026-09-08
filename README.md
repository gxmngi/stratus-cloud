# Stratus Cloud

> A lightweight, self-hosted Cloud Deployment Platform (Mini-Vercel / PaaS) built from scratch with Next.js 15, Go, Docker, and Redis.

![Stratus Cloud Dashboard](assets/dashboard-preview.png)

Stratus Cloud is an educational, production-modeled Platform-as-a-Service (PaaS). It automates the entire lifecycle of web applications: pulling Git repositories, executing isolated builds inside ephemeral Docker containers, streaming compilation logs in real time to the browser, and serving deployments through a high-performance Go reverse proxy with dynamic subdomain routing.

---

## Key Architectural Highlights

* **Polyglot Monorepo Design:** Clean separation of concerns featuring a Next.js 15 UI, a TypeScript Builder & Orchestrator, and a high-performance edge proxy written in Go.
* **Isolated Ephemeral Sandboxes:** Every build executes inside a throwaway Docker container (
ode:20-alpine) with strict resource constraints (1GB RAM, 1.0 CPU quota) to isolate and shield the host from malicious supply-chain scripts.
* **Intelligent Package Manager Auto-Detection:** Inspects project root files on the fly and dynamically switches between pnpm, yarn, un, and 
pm without requiring manual configuration.
* **High-Performance Go Edge Proxy:** Built with 100% Go Standard Library (
et/http). Handles dynamic subdomain routing (*.localhost:8000), RFC 6761 localhost wildcard resolution, and Single Page Application (SPA) client-side routing fallbacks.
* **Decoupled Real-Time Log Pipeline:** Completely separates build workers from web clients using Redis Pub/Sub channels and WebSockets, streaming container stdout/stderr line-by-line directly to an embedded xterm.js terminal emulator.

---

## Distributed System Architecture

`
[ Developer / Browser ]
         │
         ├──────────────────────────────────────────┐
         │ 1. POST /api/deploy                      │ 4. WebSocket (ws://.../logs)
         ▼                                          ▼
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│  services/api (REST & Gateway)   │      │  apps/web (Next.js 15 Dashboard) │
│  • Generates deployment ID       │      │  • Real-time xterm.js terminal   │
│  • Enqueues build job            │      │  • Interactive build status      │
└────────────────┬─────────────────┘      └──────────────────────────────────┘
                 │                                  ▲
                 │ 2. LPUSH queue:build             │ 5. Subscribes & forwards logs
                 ▼                                  │
      ┌─────────────────────┐             ┌─────────┴───────────┐
      │     Redis Queue     │             │    Redis Pub/Sub    │
      │    (queue:build)    │             │ (logs:<deployment>) │
      └──────────┬──────────┘             └─────────▲───────────┘
                 │                                  │
                 │ 3. BLPOP (worker picks job)      │ 6. PUBLISH stdout/stderr
                 ▼                                  │
┌───────────────────────────────────────────────────┴────────────────┐
│  services/builder (Docker Sandbox Daemon)                          │
│  • Clones target repository                                        │
│  • Auto-detects package manager (pnpm/yarn/bun/npm)                │
│  • Mounts isolated volume into ephemeral container                 │
│  • Extracts compiled static artifacts (dist/ / build/)             │
└────────────────┬───────────────────────────────────────────────────┘
                 │
                 │ 7. Writes compiled output to disk
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  services/proxy (Go Edge Reverse Proxy - Port 8000)                │
│  • Intercepts Host: <deployment-id>.localhost:8000               │
│  • Zero-dependency high-throughput static asset streaming          │
│  • SPA fallback for React/TanStack client-side routing             │
└────────────────────────────────────────────────────────────────────┘
`

---

## Repository Structure

`
stratus-cloud/
├── apps/
│   └── web/              # Next.js 15 Developer Dashboard with xterm.js
├── services/
│   ├── api/              # REST Orchestrator API & WebSocket Gateway (Node/TS)
│   ├── builder/          # Docker Sandbox Build Engine (Dockerode)
│   └── proxy/            # High-Performance Edge Reverse Proxy (Go)
├── fixtures/
│   └── demo-app/         # Minimal, zero-bloat test application
└── assets/               # Architecture diagrams and preview assets
`

---

## Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) v20+
* [Go](https://go.dev/) v1.22+
* [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Engine running)
* [Git](https://git-scm.com/)

### 1. Start Redis
`ash
docker run -d --name stratus-redis -p 6379:6379 redis:alpine
`

### 2. Start the Go Edge Proxy (Port 8000)
`ash
cd services/proxy
go run main.go
`

### 3. Start the Builder Worker Daemon
`ash
cd services/builder
npm install
npx tsx src/index.ts
`

### 4. Start the API & WebSocket Gateway (Port 4000)
`ash
cd services/api
npm install
npx tsx src/index.ts
`

### 5. Start the Developer Dashboard (Port 3000)
`ash
cd apps/web
npm install
npm run dev
`

Open [http://localhost:3000](http://localhost:3000) in your browser, enter any Git repository or local fixture path, click **Deploy**, and watch your application build and deploy with live streaming logs.

---

## License

MIT

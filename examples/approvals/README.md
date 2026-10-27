# approvals example

A Worker with one `Script` Durable Object. It runs an agent-style script that lists issues, asks a
human about each one, and closes the approved ones. `e2e.mjs` drives it under `wrangler dev`, aborting
the object and SIGKILLing workerd between answers.

```sh
npm run e2e                                    # from the repo root
npx wrangler dev -c examples/approvals/wrangler.jsonc
curl -X POST --data-binary 'tool("ask_human", { question: "ship it?" })' localhost:8787/p/demo/run
curl -X POST localhost:8787/p/demo/kill
curl -X POST -d '{"token":"<token from the run>","value":true}' localhost:8787/p/demo/answer
```

Routes: `POST /p/:id/run` (body: the script), `/answer` (`{ token, value }`), `/recover`, `/closed`, `/kill`.

The routes run code you send them and have no auth. Keep it local, or put it behind Cloudflare Access.

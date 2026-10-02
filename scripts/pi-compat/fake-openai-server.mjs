import http from "node:http"; import { appendFileSync } from "node:fs";
const log = process.env.REQUEST_LOG;
http.createServer(async (req, res) => {
  if (req.method === "GET") { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({object:"list",data:[{id:"fake",object:"model"}]})); return; }
  let raw = ""; for await (const d of req) raw += d; const body = JSON.parse(raw);
  const tools = (body.tools||[]).map(t=>t?.function?.name);
  const advisor = tools.includes("advise");
  appendFileSync(log, JSON.stringify({ t: Date.now(), advisor, messages: body.messages }) + "\n");
  const delay = advisor ? 0 : Number(process.env.PRIMARY_DELAY_MS||800);
  await new Promise(r => setTimeout(r, delay));
  res.writeHead(200, {"content-type":"text/event-stream"});
  const c = (delta, fr=null) => `data: ${JSON.stringify({id:"x",object:"chat.completion.chunk",created:0,model:"fake",choices:[{index:0,delta,finish_reason:fr}]})}\n\n`;
  res.write(c({role:"assistant",content: advisor ? "nothing to add" : "primary reply"}));
  res.write(c({}, "stop")); res.end("data: [DONE]\n\n");
}).listen(Number(process.env.PORT), "127.0.0.1");

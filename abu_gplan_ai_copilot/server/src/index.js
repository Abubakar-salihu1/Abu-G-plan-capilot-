import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import multer from "multer";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import mammoth from "mammoth";
import sharp from "sharp";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const archiver = require("archiver");

dotenv.config();
const app = express();
const port = process.env.PORT || 5000;
app.use(cors({origin: process.env.CLIENT_ORIGIN || "*"}));
app.use(express.json({limit:"2mb"}));

const upload = multer({storage: multer.memoryStorage(), limits:{fileSize:10*1024*1024, files:5}});

/* ---------- Generated app builds: on-disk storage + static preview ---------- */
const BUILDS_DIR = path.join(process.cwd(), "builds");
if(!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, {recursive:true});
app.use("/preview", express.static(BUILDS_DIR));
app.use("/builds", express.static(BUILDS_DIR));

/* ---------- MongoDB (users + conversations) ---------- */
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let usersCollection;
let conversationsCollection;
async function connectDB(){
  await mongoClient.connect();
  const db = mongoClient.db();
  usersCollection = db.collection("users");
  conversationsCollection = db.collection("conversations");
  await usersCollection.createIndex({email:1},{unique:true});
  await conversationsCollection.createIndex({userId:1, updatedAt:-1});
  console.log("Connected to MongoDB");
}
connectDB().catch(err=>console.error("MongoDB connection error:", err.message));

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me_in_render_env_vars";

function signToken(user){
  return jwt.sign({sub:user._id.toString(), email:user.email}, JWT_SECRET, {expiresIn:"30d"});
}

function authMiddleware(req,res,next){
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if(!token) return res.status(401).json({error:"Please log in to continue."});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {id:payload.sub, email:payload.email};
    next();
  }catch(e){
    return res.status(401).json({error:"Your session has expired. Please log in again."});
  }
}

/* ---------- Auth routes ---------- */
app.post("/api/auth/signup", async(req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const password=String(req.body?.password||"");
    if(!email||!email.includes("@")) return res.status(400).json({error:"A valid email is required."});
    if(password.length<6) return res.status(400).json({error:"Password must be at least 6 characters."});
    if(!usersCollection) return res.status(503).json({error:"Database is not ready yet. Try again in a moment."});
    const existing = await usersCollection.findOne({email});
    if(existing) return res.status(409).json({error:"An account with this email already exists."});
    const passwordHash = await bcrypt.hash(password,10);
    const result = await usersCollection.insertOne({email,passwordHash,createdAt:new Date()});
    const token = signToken({_id:result.insertedId, email});
    res.status(201).json({token,email});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Signup failed. Please try again."});
  }
});

app.post("/api/auth/login", async(req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const password=String(req.body?.password||"");
    if(!usersCollection) return res.status(503).json({error:"Database is not ready yet. Try again in a moment."});
    const user = await usersCollection.findOne({email});
    if(!user) return res.status(401).json({error:"Incorrect email or password."});
    const ok = await bcrypt.compare(password, user.passwordHash);
    if(!ok) return res.status(401).json({error:"Incorrect email or password."});
    const token = signToken(user);
    res.json({token,email:user.email});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Login failed. Please try again."});
  }
});

app.get("/api/auth/me", authMiddleware, (req,res)=>{
  res.json({email:req.user.email});
});

app.get("/api/health", (_req,res)=>res.json({ok:true,name:"Abu Gplan AI Copilot",time:new Date().toISOString()}));

/* ---------- Conversations (persisted in MongoDB, scoped per user) ---------- */
app.get("/api/conversations", authMiddleware, async(req,res)=>{
  try{
    const list = await conversationsCollection
      .find({userId:req.user.id})
      .project({title:1,updatedAt:1})
      .sort({updatedAt:-1})
      .toArray();
    res.json(list.map(c=>({id:c._id,title:c.title,updatedAt:c.updatedAt})));
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Failed to load conversations."});
  }
});

app.get("/api/conversations/:id", authMiddleware, async(req,res)=>{
  try{
    const c = await conversationsCollection.findOne({_id:req.params.id, userId:req.user.id});
    if(!c) return res.status(404).json({error:"Conversation not found"});
    res.json({id:c._id, title:c.title, updatedAt:c.updatedAt, messages:c.messages||[]});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Failed to load conversation."});
  }
});

app.post("/api/conversations", authMiddleware, async(req,res)=>{
  try{
    const id=crypto.randomUUID();
    const c={_id:id,userId:req.user.id,title:String(req.body?.title||"New conversation").slice(0,100),updatedAt:Date.now(),messages:[]};
    await conversationsCollection.insertOne(c);
    res.status(201).json({id:c._id,title:c.title,updatedAt:c.updatedAt,messages:c.messages});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Failed to create conversation."});
  }
});

app.delete("/api/conversations/:id", authMiddleware, async(req,res)=>{
  try{
    await conversationsCollection.deleteOne({_id:req.params.id, userId:req.user.id});
    res.status(204).end();
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Failed to delete conversation."});
  }
});

/* ---------- File extraction (images resized/compressed to avoid oversized Groq requests) ---------- */
async function extractFileContent(file){
  const {mimetype, originalname, buffer} = file;

  if(mimetype && mimetype.startsWith("image/")){
    let outBuffer = buffer;
    try{
      outBuffer = await sharp(buffer)
        .resize({width:1024, withoutEnlargement:true})
        .jpeg({quality:75})
        .toBuffer();
    }catch(e){
      console.error(`Image resize failed for ${originalname}, falling back to original buffer:`, e.message);
    }
    return {type:"image", name:originalname, dataUrl:`data:image/jpeg;base64,${outBuffer.toString("base64")}`};
  }

  if(mimetype === "application/pdf"){
    try{
      const data = await pdfParse(buffer);
      return {type:"text", name:originalname, text:data.text.slice(0,8000)};
    }catch(e){
      return {type:"text", name:originalname, text:`[Could not read PDF file: ${originalname}]`};
    }
  }

  if(mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"){
    try{
      const {value} = await mammoth.extractRawText({buffer});
      return {type:"text", name:originalname, text:value.slice(0,8000)};
    }catch(e){
      return {type:"text", name:originalname, text:`[Could not read Word document: ${originalname}]`};
    }
  }

  if(mimetype === "text/plain"){
    return {type:"text", name:originalname, text:buffer.toString("utf-8").slice(0,8000)};
  }

  return {type:"text", name:originalname, text:`[Unsupported file type: ${originalname}]`};
}

/* ---------- Trim conversation history before sending to the AI provider ---------- */
function trimHistory(messages, maxChars = 20000){
  let total = 0;
  const kept = [];
  for(let i = messages.length - 1; i >= 0; i--){
    const len = JSON.stringify(messages[i]).length;
    if(total + len > maxChars && kept.length > 0) break;
    kept.unshift(messages[i]);
    total += len;
  }
  return kept;
}

async function callAI(messages, model, systemPrompt, options={}){
  const {AI_API_URL,AI_API_KEY}=process.env;
  const useModel = model || process.env.AI_MODEL;
  if(!AI_API_URL||!AI_API_KEY||!useModel||AI_API_KEY==="your_api_key_here")
    return "Abu Gplan AI Copilot is ready, but the AI provider is not configured yet. Add AI_API_URL, AI_API_KEY and AI_MODEL to server/.env and restart the server.";

  const system={role:"system",content: systemPrompt || "You are Abu Gplan AI Copilot, a capable general-purpose AI assistant. Help solve problems, write and debug code, analyze information, plan projects, draft documents, explain difficult topics, and brainstorm. Be accurate, practical, and honest about uncertainty. Do not claim access to systems or information you do not have. When the user attaches images or documents, use their content to inform your answer."};

  const trimmed = trimHistory(messages);

  async function doRequest(useJsonMode){
    const body = {
      model:useModel,
      messages:[system,...trimmed],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens || 4096
    };
    if(useJsonMode) body.response_format = {type:"json_object"};

    const r=await fetch(AI_API_URL,{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${AI_API_KEY}`},
      body:JSON.stringify(body)
    });
    return r;
  }

  let r = await doRequest(!!options.jsonMode);

  // Some Groq models don't support response_format:json_object and return HTTP 400.
  // Retry once without it rather than failing outright — the system prompt still
  // instructs JSON-only output, so this is a safe fallback.
  if(!r.ok && r.status===400 && options.jsonMode){
    const firstErrBody = await r.text().catch(()=> "");
    console.error("Groq rejected json_object mode, retrying without it. Original error:", firstErrBody);
    r = await doRequest(false);
  }

  if(!r.ok){
    const errBody = await r.text().catch(()=> "");
    console.error(`Groq error (HTTP ${r.status}):`, errBody);
    let detail = "";
    try{ detail = JSON.parse(errBody)?.error?.message || ""; }catch{}
    if(r.status===429){
      throw new Error("The AI provider is temporarily rate-limiting requests. Please wait a moment and try again.");
    }
    throw new Error(detail ? `AI provider error: ${detail}` : `AI provider returned HTTP ${r.status}`);
  }

  const data=await r.json();
  const choice = data?.choices?.[0];
  if(choice?.finish_reason === "length"){
    console.error("Groq response was cut off (finish_reason=length). Consider raising maxTokens.");
  }
  return choice?.message?.content || "No response was returned by the AI provider.";
}

/* ---------- Predictive follow-up suggestions after each chat reply ---------- */
const SUGGESTIONS_SYSTEM_PROMPT = `Based on the conversation so far, suggest 3 short, specific follow-up messages the user might naturally want to send next.
Respond with a single JSON object: {"suggestions":["...", "...", "..."]}
Rules:
- Each suggestion must be under 8 words, written from the user's point of view (as if the user is about to type it).
- Make them genuinely useful next steps, not generic ("tell me more").
- No numbering, no quotes within the strings, no explanation outside the JSON object.`;

async function generateSuggestions(recentMessages, model){
  try{
    const raw = await callAI(recentMessages, model, SUGGESTIONS_SYSTEM_PROMPT, {jsonMode:true, maxTokens:300, temperature:0.6});
    let text = String(raw||"").trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if(firstBrace===-1||lastBrace===-1) return [];
    const obj = JSON.parse(text.slice(firstBrace, lastBrace+1));
    return Array.isArray(obj.suggestions) ? obj.suggestions.filter(s=>typeof s==="string").slice(0,3) : [];
  }catch(e){
    console.error("Suggestion generation failed (non-fatal):", e.message);
    return [];
  }
}

app.post("/api/chat", authMiddleware, upload.array("files", 5), async(req,res)=>{
  try{
    const message=String(req.body?.message||"").trim();
    const files=req.files||[];
    if(!message && files.length===0) return res.status(400).json({error:"Message is required."});

    const convId = req.body?.conversationId || crypto.randomUUID();
    let c = await conversationsCollection.findOne({_id:convId, userId:req.user.id});
    if(!c){
      c = {_id:convId, userId:req.user.id, title:(message||files[0]?.originalname||"New conversation").slice(0,60), updatedAt:Date.now(), messages:[]};
    }

    const extracted = await Promise.all(files.map(extractFileContent));
    const images = extracted.filter(f=>f.type==="image").slice(0,5);
    const textFiles = extracted.filter(f=>f.type==="text");
    const textFilesBlock = textFiles.length ? textFiles.map(f=>`[Attached file: ${f.name}]\n${f.text}`).join("\n\n") : "";

    let displayContent = message;
    if(textFilesBlock) displayContent += (displayContent?"\n\n":"") + textFilesBlock;
    if(images.length) displayContent += (displayContent?"\n\n":"") + images.map(f=>`[Attached image: ${f.name}]`).join("\n");

    c.messages.push({role:"user",content:displayContent});

    let apiMessages = c.messages.map(m=>({role:m.role,content:m.content}));
    let model = req.body?.model || process.env.AI_MODEL;

    if(images.length){
      model = process.env.AI_VISION_MODEL || "qwen/qwen3.6-27b";
      const lastIdx = apiMessages.length-1;
      const contentArr=[{type:"text", text: (message||"") + (textFilesBlock? "\n\n"+textFilesBlock : "")}];
      images.forEach(img=>contentArr.push({type:"image_url", image_url:{url:img.dataUrl}}));
      apiMessages[lastIdx] = {role:"user", content:contentArr};
    }

    const answer=await callAI(apiMessages, model);
    c.messages.push({role:"assistant",content:answer});
    c.updatedAt=Date.now();

    await conversationsCollection.updateOne(
      {_id:c._id},
      {$set:{userId:c.userId, title:c.title, updatedAt:c.updatedAt, messages:c.messages}},
      {upsert:true}
    );

    // Suggestions are a nice-to-have — generate them off the already-updated
    // conversation, but never let a failure here break the actual chat reply.
    const suggestions = await generateSuggestions(
      [...c.messages.slice(-6).map(m=>({role:m.role,content:typeof m.content==="string"?m.content:""}))],
      model
    );

    res.json({conversationId:c._id,answer,suggestions});
  }catch(e){console.error(e);res.status(500).json({error:e.message||"Server error"});}
});

/* ---------- Build a runnable web app: AI returns structured files, we write + zip + preview them ---------- */
const BUILD_SYSTEM_PROMPT = `You are a code generation engine. The user will describe a web app they want — sometimes in full detail, sometimes as just a short hint or theme (e.g. "a fitness tracker" or "something for recipe sharing").
When the description is short or vague, do NOT ask clarifying questions — use your judgment to invent a complete, sensible feature set, layout, and visual style that fits the theme, and build that. Make creative, reasonable decisions rather than a bare-minimum interpretation.
You must respond with a single JSON object matching this exact shape:
{"files":[{"path":"index.html","content":"..."}, {"path":"style.css","content":"..."}, {"path":"script.js","content":"..."}]}
Rules:
- Always include an index.html as the entry point, with relative links to any css/js files you create (e.g. <link rel="stylesheet" href="style.css">, <script src="script.js"></script>).
- Keep it to plain HTML, CSS, and vanilla JavaScript only — no build tools, no frameworks requiring a bundler, no external npm packages. External CDN <script>/<link> tags are fine.
- Keep the project reasonably compact so the full response fits — favor a clean, working single-page app over an elaborate one that might get cut off.
- Make it a complete, runnable, self-contained static site with no missing files.
- The entire response body must be valid JSON and nothing else.`;

const SURPRISE_PROMPT = "Invent an original, useful, and visually polished web app idea from scratch — something genuinely creative, not generic. Then build it.";

function safeParseBuildJSON(raw){
  let text = String(raw||"").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if(firstBrace===-1||lastBrace===-1) throw new Error("AI did not return JSON.");
  text = text.slice(firstBrace, lastBrace+1);
  let parsed;
  try{
    parsed = JSON.parse(text);
  }catch(jsonErr){
    throw new Error(`AI response was not valid JSON (${jsonErr.message}). This usually means the response was cut off — try a simpler request.`);
  }
  if(!parsed || !Array.isArray(parsed.files) || parsed.files.length===0){
    throw new Error("AI response was missing a valid files array.");
  }
  return parsed;
}

function safeRelativePath(p){
  const cleaned = String(p||"").replace(/^\/+/,"").split("/").filter(seg=>seg && seg!=="..").join("/");
  return cleaned || "index.html";
}

function isValidBuildId(id){
  return typeof id==="string" && /^[0-9a-f-]{36}$/i.test(id);
}

// Recursively read every file in a build directory back into the same
// {path, content} shape the AI produces, so we can hand the current
// project back to the model as context for an edit.
function readBuildFiles(buildDir){
  const files=[];
  function walk(dir, prefix){
    for(const entry of fs.readdirSync(dir, {withFileTypes:true})){
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if(entry.isDirectory()){
        walk(full, rel);
      }else{
        files.push({path:rel, content:fs.readFileSync(full,"utf-8")});
      }
    }
  }
  walk(buildDir, "");
  return files;
}

// Writes a set of {path, content} files into a fresh build directory,
// zips it, and returns the same shape used by both /api/build and
// /api/build/:id/edit responses.
async function persistBuild(files){
  const hasIndex = files.some(f=>safeRelativePath(f.path).toLowerCase()==="index.html");
  if(!hasIndex) throw new Error("The generated project had no index.html entry point.");

  const buildId = crypto.randomUUID();
  const buildDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(buildDir, {recursive:true});

  const writtenFiles = [];
  for(const f of files){
    const relPath = safeRelativePath(f.path);
    const fullPath = path.join(buildDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), {recursive:true});
    fs.writeFileSync(fullPath, String(f.content||""), "utf-8");
    writtenFiles.push(relPath);
  }

  const zipPath = path.join(BUILDS_DIR, `${buildId}.zip`);
  await new Promise((resolve, reject)=>{
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", {zlib:{level:9}});
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(buildDir, false);
    archive.finalize();
  });

  return {
    buildId,
    files: writtenFiles,
    previewUrl: `/preview/${buildId}/index.html`,
    downloadUrl: `/builds/${buildId}.zip`
  };
}

app.post("/api/build", authMiddleware, async(req,res)=>{
  try{
    const surprise = !!req.body?.surprise;
    const prompt = surprise ? SURPRISE_PROMPT : String(req.body?.prompt||"").trim();
    if(!prompt) return res.status(400).json({error:"Describe the app you want built."});

    const model = process.env.AI_BUILD_MODEL || process.env.AI_MODEL;
    const raw = await callAI([{role:"user", content:prompt}], model, BUILD_SYSTEM_PROMPT, {jsonMode:true, maxTokens:8000, temperature: surprise ? 0.9 : 0.3});

    let parsed;
    try{
      parsed = safeParseBuildJSON(raw);
    }catch(parseErr){
      console.error("Build JSON parse failed. Raw AI output:", raw);
      return res.status(502).json({error: parseErr.message || "The AI did not return a valid project structure. Try rephrasing your request."});
    }

    const result = await persistBuild(parsed.files);
    res.json(result);
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message||"Build failed."});
  }
});

/* ---------- Edit/refine an existing build via follow-up instruction ---------- */
const EDIT_SYSTEM_PROMPT = `You are a code generation engine maintaining an existing static web project.
The user will give you the CURRENT project files followed by an instruction describing a change.
You must respond with a single JSON object matching this exact shape:
{"files":[{"path":"index.html","content":"..."}, ...]}
Rules:
- Return the COMPLETE, UPDATED set of project files — every file the project needs to run, not just the ones you changed.
- Preserve everything from the current project that the instruction does not ask you to change.
- Keep it to plain HTML, CSS, and vanilla JavaScript only — no build tools, no bundler-based frameworks. External CDN <script>/<link> tags are fine.
- Always include an index.html entry point.
- Keep the project reasonably compact so the full response fits — favor a clean, working result over an elaborate one that might get cut off.
- The entire response body must be valid JSON and nothing else.`;

app.post("/api/build/:buildId/edit", authMiddleware, async(req,res)=>{
  try{
    const {buildId} = req.params;
    const instruction = String(req.body?.instruction||"").trim();
    if(!instruction) return res.status(400).json({error:"Describe the change you want to make."});
    if(!isValidBuildId(buildId)) return res.status(400).json({error:"Invalid build id."});

    const buildDir = path.join(BUILDS_DIR, buildId);
    if(!fs.existsSync(buildDir)) return res.status(404).json({error:"That build no longer exists on the server."});

    const currentFiles = readBuildFiles(buildDir);
    const filesBlock = currentFiles.map(f=>`--- FILE: ${f.path} ---\n${f.content}`).join("\n\n");
    const userContent = `Current project files:\n\n${filesBlock}\n\n--- INSTRUCTION ---\n${instruction}`;

    const model = process.env.AI_BUILD_MODEL || process.env.AI_MODEL;
    const raw = await callAI([{role:"user", content:userContent}], model, EDIT_SYSTEM_PROMPT, {jsonMode:true, maxTokens:8000});

    let parsed;
    try{
      parsed = safeParseBuildJSON(raw);
    }catch(parseErr){
      console.error("Build edit JSON parse failed. Raw AI output:", raw);
      return res.status(502).json({error: parseErr.message || "The AI did not return a valid project structure. Try rephrasing your change."});
    }

    const result = await persistBuild(parsed.files);
    res.json({...result, editedFrom:buildId});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message||"Edit failed."});
  }
});

app.listen(port,()=>console.log(`Abu Gplan AI Copilot backend: http://localhost:${port}`));

import json, csv, sys
sys.path.insert(0,'.')
from taxonomy import SKILLS, ROLES
from catalog import ITEMS
import lint
OUT='..'
skills=[{"id":i,"name":n,"category":c,"keywords":k} for i,n,c,k in SKILLS]
sid={s["id"] for s in skills}
rid={r["id"] for r in ROLES}
iid={i["id"] for i in ITEMS}
by_id={i["id"]:i for i in ITEMS}
errs=[]
for it in ITEMS:
    for s in it["skills"]:
        if s not in sid: errs.append(f"{it['id']}: unknown skill {s}")
    for r in it["roles"]:
        if r!="*" and r not in rid: errs.append(f"{it['id']}: unknown role {r}")
    for p in it["prerequisites"]+it["free_alternative_ids"]:
        if p not in iid: errs.append(f"{it['id']}: unknown ref {p}")
for r in ROLES:
    for s in r["skills"]:
        if s not in sid: errs.append(f"role {r['id']}: unknown skill {s}")
if len(iid)!=len(ITEMS): errs.append("duplicate item ids")
errs += lint.check_items(ITEMS)
from questions import Q, FOLLOW_UPS
errs += lint.check_setup_questions(Q)
if errs: print("\n".join(errs)); sys.exit(1)

REC={"high":3,"medium":2,"low":1}
def score(item, role):
    w=sum(role["skills"].get(s,0) for s in item["skills"])
    tag = 2 if role["id"] in item["roles"] or "*" in item["roles"] else 0
    # Verified items outrank unverified ones, so a new unverified item cannot push a verified one out.
    verified = (4 if item["url_verified"] else 0) + (2 if item["price_verified"] else 0)
    return w + tag + REC[item["recognition"]] + verified
# Kept out of `core` (they stay in optional / free_only): the page returned only a title, or the
# credential needs prior work experience, so they are not a safe first step.
NOT_FOR_CORE={"aipb-certified-bookkeeper","cisco-cybersecurity-essentials","netacad-networking-essentials","kaggle-data-cleaning"}
roles_out=[]
for r in ROLES:
    ranked=sorted([i for i in ITEMS if (r["id"] in i["roles"] or "*" in i["roles"])
                       and (i["url"] or i["type"]=="practice")], key=lambda i:-score(i,r))
    # Pick the 6 best items by score, as before; each pick brings its transitive required
    # prerequisites along as a bundle (prerequisites first), so core may hold more than 6 ids.
    core=[]; picked=set()
    for i in ranked:
        if i["type"]=="practice" or i["id"] in NOT_FOR_CORE: continue
        if i["cost_type"]=="free_audit" and any(i["id"] in x["free_alternative_ids"] for x in ITEMS): continue
        for x in lint.ordered_required_closure(i["id"], by_id):
            if x not in core: core.append(x)
        picked.add(i["id"])
        if len(picked)==6: break
    practice=[i["id"] for i in ranked if i["type"]=="practice"][:4]
    optional=[i["id"] for i in ranked if i["type"]!="practice" and i["id"] not in core][:6]
    free_path=[i["id"] for i in ranked if i["cost_type"] in ("free","free_audit") and i["type"]!="practice"][:6]
    roles_out.append({**r,"skills":[{"skill":k,"weight":v} for k,v in r["skills"].items()],
        "suggested_path":{"core":core,"optional":optional,"practice":practice,"free_only":free_path},
        "suggested_path_note":"Auto-ranked by skill weight, role tag and certificate recognition. A starting point for the plan builder, not a final plan."})

errs=lint.check_role_paths(ITEMS, roles_out)
if errs: print("\n".join(errs)); sys.exit(1)

def cost_text(i):
    if i["cost_type"]=="free": return "Free"
    if i["cost_type"]=="free_audit": return f"Free to audit; certificate about ${i['certificate_price']}" if i["certificate_price"] else "Free to audit; certificate paid"
    if i["cost_type"]=="subscription":
        return f"${i['price']}/{i['subscription_period']} subscription" if i["price"] is not None else "Subscription (price varies – check)"
    return f"${i['price']}" if i["price"] is not None else "Paid (price varies – check)"
skill_name={s["id"]:s["name"] for s in skills}
role_title={r["id"]:r["title"] for r in ROLES}
docs=[]
for i in ITEMS:
    roles_txt=", ".join(role_title[x] for x in i["roles"] if x!="*") or "All roles"
    kws=sorted({k for s in i["skills"] for k in next(x["keywords"] for x in skills if x["id"]==s)})
    text=(f"{i['title']} by {i['provider']}. Type: {i['type'].replace('_',' ')}. Level: {i['level']}. "
          f"Skills: {', '.join(skill_name[s] for s in i['skills'])}. Relevant roles: {roles_txt}. "
          f"Estimated time: {i['est_hours']} hours. Cost: {cost_text(i)}. Certificate: {i['certificate_type'].replace('_',' ')} "
          f"(recognition: {i['recognition']}). {i['notes']} Keywords: {', '.join(kws)}.").replace("  "," ").strip()
    docs.append({"id":f"item:{i['id']}","kind":"catalog_item","ref_id":i["id"],"text":text,
        "metadata":{"type":i["type"],"cost_type":i["cost_type"],"price":i["price"],"currency":i["currency"],
        "certificate_type":i["certificate_type"],"recognition":i["recognition"],"est_hours":i["est_hours"],
        "level":i["level"],"skills":i["skills"],"roles":i["roles"],"url_verified":i["url_verified"],
        "last_verified_at":i["last_verified_at"],"subscription_group":i["subscription_group"]}})
for r in roles_out:
    top=", ".join(f"{skill_name[s['skill']]} ({s['weight']}/5)" for s in sorted(r["skills"],key=lambda s:-s["weight"]))
    text=(f"Role: {r['title']}. Also known as: {', '.join(r['aliases'])}. {r['summary']} "
          f"Key skills (importance): {top}. Job-description keywords: {', '.join(r['jd_keywords'])}.")
    docs.append({"id":f"role:{r['id']}","kind":"role","ref_id":r["id"],"text":text,"metadata":{"skills":[s["skill"] for s in r["skills"]]}})
for s in skills:
    docs.append({"id":f"skill:{s['id']}","kind":"skill","ref_id":s["id"],
        "text":f"Skill: {s['name']} ({s['category']}). Related terms: {', '.join(s['keywords'])}.","metadata":{"category":s["category"]}})

meta={"version":"0.1.0","generated":"2026-11-01","currency_default":"USD",
      "attribution":"Some skills and roles include information from O*NET OnLine by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA), used under the CC BY 4.0 license (https://creativecommons.org/licenses/by/4.0/); O*NET is a trademark of USDOL/ETA, Upversion has modified the information and USDOL/ETA has not approved or endorsed it. Some mappings use the ESCO classification of the European Commission (adapted by Upversion, marked as modified; ESCO version needs check). See README.md, Attribution.",
      "verification_note":"url_verified/price_verified = confirmed from a source found during research (latest link check and batch 3 research: 2026-11-01). False = plausible but must be checked before showing as verified. Prices change; re-check before purchase."}
json.dump({"meta":meta,"items":ITEMS},open(f"{OUT}/catalog.json","w"),indent=2,ensure_ascii=False)
json.dump({"meta":meta,"roles":roles_out},open(f"{OUT}/roles.json","w"),indent=2,ensure_ascii=False)
json.dump({"meta":meta,"skills":skills},open(f"{OUT}/skills.json","w"),indent=2,ensure_ascii=False)
with open(f"{OUT}/documents.jsonl","w") as f:
    for d in docs: f.write(json.dumps(d,ensure_ascii=False)+"\n")
with open(f"{OUT}/catalog.csv","w",newline="") as f:
    w=csv.writer(f); w.writerow(["id","title","provider","type","cost","certificate","recognition","hours","skills","roles","url","url_verified","price_verified","last_verified_at","subscription_group","prerequisites"])
    for i in ITEMS: w.writerow([i["id"],i["title"],i["provider"],i["type"],cost_text(i),i["certificate_type"],i["recognition"],i["est_hours"],";".join(i["skills"]),";".join(i["roles"]),i["url"] or "",i["url_verified"],i["price_verified"],i["last_verified_at"] or "",i["subscription_group"] or "",";".join(p+":"+i["prerequisite_kinds"][p] for p in i["prerequisites"])])
print(f"items={len(ITEMS)} roles={len(ROLES)} skills={len(skills)} docs={len(docs)}")
print("verified urls:",sum(i['url_verified'] for i in ITEMS if i['type']!='practice'),"of",sum(1 for i in ITEMS if i['type']!='practice'))

# ---------- seed.sql ----------
def q(v):
    if v is None: return "null"
    if isinstance(v,bool): return "true" if v else "false"
    if isinstance(v,(int,float)): return str(v)
    if isinstance(v,list): return "array[" + ",".join(q(x) for x in v) + "]::text[]" if v else "'{}'::text[]"
    if isinstance(v,dict): return q(json.dumps(v)) + "::jsonb"
    return "'" + str(v).replace("'","''") + "'"
L=["-- Generated from catalog.json, roles.json, skills.json. Load after schema.sql (set search_path first).","begin;"]
for s in skills: L.append(f"insert into skills (id,name,category,keywords) values ({q(s['id'])},{q(s['name'])},{q(s['category'])},{q(s['keywords'])}) on conflict (id) do nothing;")
for r in roles_out:
    L.append(f"insert into roles (id,title,aliases,summary,jd_keywords,suggested_path) values ({q(r['id'])},{q(r['title'])},{q(r['aliases'])},{q(r['summary'])},{q(r['jd_keywords'])},{q(r['suggested_path'])}) on conflict (id) do nothing;")
    for s in r["skills"]: L.append(f"insert into role_skills values ({q(r['id'])},{q(s['skill'])},{s['weight']}) on conflict do nothing;")
cols=["id","title","provider","url","type","cost_type","price","currency","subscription_period","certificate_price","certificate_type","recognition","est_hours","level","format","language","notes","url_verified","price_verified","source","last_verified_at","subscription_group"]
for i in ITEMS:
    L.append(f"insert into catalog_items ({','.join(cols)}) values ({','.join(q(i[c]) for c in cols)}) on conflict (id) do nothing;")
for i in ITEMS:
    for s in i["skills"]: L.append(f"insert into item_skills (item_id,skill_id,depth) values ({q(i['id'])},{q(s)},{q(i['skill_depth'].get(s))}) on conflict do nothing;")
    for r in i["roles"]: L.append(f"insert into item_roles values ({q(i['id'])},{q(r)}) on conflict do nothing;")
    for p in i["prerequisites"]: L.append(f"insert into item_links (item_id,related_id,kind,prerequisite_kind) values ({q(i['id'])},{q(p)},'prerequisite',{q(i['prerequisite_kinds'][p])}) on conflict do nothing;")
    for p in i["free_alternative_ids"]: L.append(f"insert into item_links (item_id,related_id,kind) values ({q(i['id'])},{q(p)},'free_alternative') on conflict do nothing;")
for d in docs: L.append(f"insert into rag_documents (id,kind,ref_id,content,metadata) values ({q(d['id'])},{q(d['kind'])},{q(d['ref_id'])},{q(d['text'])},{q(d['metadata'])}) on conflict (id) do update set content=excluded.content, metadata=excluded.metadata;")
L.append("commit;")
open(f"{OUT}/seed.sql","w").write("\n".join(L)+"\n")
print("seed.sql lines:",len(L))

# ---------- questions.json ----------
qids=[q["id"] for q in Q]
assert len(qids)==len(set(qids)), "duplicate question ids"
for q in Q:
    for k in (q.get("show_if") or {}): assert k in qids, f"{q['id']}: show_if refers to unknown question {k}"
    for o in q.get("options",[]):
        if isinstance(o,dict):
            for r in o.get("roles",[]): assert r in rid, f"{q['id']}: unknown role {r}"
stages=["goal","discovery","background","skills","time","budget","style"]
qmeta={"version":"0.1.0","generated":"2026-10-29","stages":stages,
 "notes":"Questions are asked one stage at a time. show_if hides a question unless an earlier answer matches. maps_to names the Goal / UserProfile / WeekPattern field the answer fills (spec 3.0, section 4)."}
json.dump({"meta":qmeta,"questions":Q,"follow_ups":FOLLOW_UPS},open(f"{OUT}/questions.json","w"),indent=2,ensure_ascii=False)
print("questions:",len(Q))

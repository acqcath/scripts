# Checks vision/app.py rerank() gives the same scores as an older copy, on a tiny random Qwen3 (no model download):
#   git show <ref>:degoog/wip/files/vision/app.py > /tmp/old.py && python3 test/rerank_equiv.py files/vision/app.py /tmp/old.py
import torch, re, sys
from transformers import Qwen3Config, Qwen3ForCausalLM
torch.manual_seed(0)
cfg=Qwen3Config(vocab_size=300,hidden_size=64,intermediate_size=128,num_hidden_layers=2,num_attention_heads=4,num_key_value_heads=2,head_dim=16,max_position_embeddings=1024)
rmodel=Qwen3ForCausalLM(cfg).eval()
class Tok:
    pad_token_id=0
    def __call__(self,texts,max_length=None,**k):
        return {"input_ids":[[3+(ord(c)%290) for c in t][:max_length] for t in texts]}
    def pad(self,enc,padding=True,return_tensors="pt"):
        L=max(len(x) for x in enc["input_ids"])
        ids=[[0]*(L-len(x))+x for x in enc["input_ids"]]; m=[[0]*(L-len(x))+[1]*len(x) for x in enc["input_ids"]]
        class D(dict):
            def to(s,d): return s
        return D(input_ids=torch.tensor(ids),attention_mask=torch.tensor(m))
rtok=Tok(); dev="cpu"; R_YES,R_NO=5,6; R_PRE=[1,2]; R_SUF=[2,1]; R_TASK="t"; R_MAX=512
src=open(sys.argv[1]).read()
new=re.search(r"(def rerank\(.*?\n    return out\n)",src,re.S).group(1)
old=new_old=open(sys.argv[2]).read(); old=re.search(r"(def rerank\(.*?\n    return out\n)",old,re.S).group(1)
import os
g=dict(globals()); exec("R_TOK=3000\n"+new,g); n=g["rerank"]
g2=dict(globals()); exec(old,g2); o=g2["rerank"]
docs=["doc "*(i%17+1)+str(i) for i in range(70)]
with torch.inference_mode():
    a=n("query",docs); b=o("query",docs)
print(max(abs(x-y) for x,y in zip(a,b)), len(a), len(b))

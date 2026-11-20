# ideax — note per Claude (non chiedere ad Andrea cose già scritte qui)

La verità VIVA su modelli e hardware è il catalogo di ideax a runtime. Questo file è
uno **snapshot** per non ri-chiedere ogni volta. Data: **20/11/2026**.

## La macchina di Andrea

- GPU: **1× RTX 4080 16 GB**. **4 monitor** attaccati alla 4080; la scheda madre non
  dà uscite per spostarli, quindi il monitor **non si può** mettere sull'integrata.
- Conseguenza misurata (due volte): **FLUX in addestramento NON entra nei 16 GB** —
  si pianta in caricamento, a passo 0. Quindi il **gemello si addestra su SDXL**
  (automatico dal 1.26.41). FLUX resta buono per la **generazione** (inferenza), dove
  16 GB bastano.
- Percorsi Windows: `C:\Users\Utente\ideax\models\...`.

## Modelli installati (snapshot)

Checkpoint:
- **realityvisionSDXL_v20** — SDXL, **file singolo**, 7,1 GB, fotoreale. È l'SDXL
  **pulito**: la base giusta per il gemello / un viso reale. Rende senza rumore.
- **Flux.1-dev** (FP8, 11,9 GB) — generazione FLUX.
- **Realistic_Vision_V6.0_NV_B1_fp16** — **SD 1.5** (non SDXL!), 2,1 GB, fotoreale.
- Espliciti (adulti), **cartelle diffusers** → colpiti dal bug del rumore su questa
  macchina (meta-device / VAE fp16): **big-lust, cyberrealistic-pony, lustify,
  pony-realism**. **Mai** come base di un viso reale: danno neve colorata.
- Pony Diffusion V6 XL — file singolo, **disattivato**.

LoRA: **Gemello · Marzia** (SDXL), **Personaggio · Anita** (SDXL, volto di fantasia),
The Ninety-Eight Percent Run (MOSS).

Cervello: **Qwen3-VL-8B-Instruct abliterated Q4** attivo (vede le immagini). Gli altri
due (gemma-4 BF16 15 GB, Llama-3.1-8B) sono disattivati — il BF16 è troppo per 16 GB.

## Regole che ne derivano

- **Viso reale (gemello) → base SDXL file-singolo PULITA** (realityvisionSDXL_v20),
  mai una base esplicita/diffusers. Vale per addestramento **e** generazione.
- Le basi esplicite (Pony/Illustrious diffusers) servono ai **personaggi inventati**
  per adulti, non a un viso reale.
- Non ri-chiedere ad Andrea hardware o elenco modelli: sta qui, e il catalogo di ideax
  è la verità viva. Se qualcosa non torna, leggi il catalogo, non chiedere.

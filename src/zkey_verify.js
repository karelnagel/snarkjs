const binFileUtils = require("./binfileutils");
const zkeyUtils = require("./zkey_utils");
const getCurve = require("./curves").getCurveFromQ;
const Blake2b = require("blake2b-wasm");
const misc = require("./misc");
const Scalar = require("ffjavascript").Scalar;
const hashToG2 = require("./keypair").hashToG2;
const sameRatio = misc.sameRatio;
const crypto = require("crypto");
const ChaCha = require("ffjavascript").ChaCha;
const newZKey = require("./zkey_new");
const {hashG1, hashPubKey} = require("./zkey_utils");


module.exports  = async function phase2verify(r1csFileName, pTauFileName, zkeyFileName, verbose) {

    let sr;
    await Blake2b.ready();

    const {fd, sections} = await binFileUtils.readBinFile(zkeyFileName, "zkey", 2);
    const zkey = await zkeyUtils.readHeader(fd, sections, "groth16");

    const curve = getCurve(zkey.q);
    await curve.loadEngine();
    const sG1 = curve.G1.F.n8*2;
    const sG2 = curve.G2.F.n8*2;

    const mpcParams = await zkeyUtils.readMPCParams(fd, curve, sections);

    const responses = [];
    const accumulatedHasher = Blake2b(64);
    accumulatedHasher.update(mpcParams.csHash);
    let curDelta = curve.G1.g;
    for (let i=0; i<mpcParams.contributions.length; i++) {
        const c = mpcParams.contributions[i];
        const ourHasher = misc.cloneHasher(accumulatedHasher);

        hashG1(ourHasher, curve, c.delta.g1_s);
        hashG1(ourHasher, curve, c.delta.g1_sx);

        if (!misc.hashIsEqual(ourHasher.digest(), c.transcript)) {
            console.log(`INVALID(${i}): Inconsistent transcript `);
            return false;
        }

        const delta_g2_sp = hashToG2(c.transcript);

        sr = await sameRatio(curve, c.delta.g1_s, c.delta.g1_sx, delta_g2_sp, c.delta.g2_spx);
        if (sr !== true) {
            console.log(`INVALID(${i}): public key G1 and G2 do not have the same ration `);
            return false;
        }

        sr = await sameRatio(curve, curDelta, c.deltaAfter, delta_g2_sp, c.delta.g2_spx);
        if (sr !== true) {
            console.log(`INVALID(${i}): deltaAfter does not fillow the public key `);
            return false;
        }

        hashPubKey(accumulatedHasher, curve, c);

        const contributionHasher = Blake2b(64);
        hashPubKey(contributionHasher, curve, c);
        responses.push(contributionHasher.digest());

        curDelta = c.deltaAfter;
    }



    const initFileName = "~" + zkeyFileName + ".init";
    await newZKey(r1csFileName, pTauFileName, initFileName);

    const {fd: fdInit, sections: sectionsInit} = await binFileUtils.readBinFile(initFileName, "zkey", 2);
    const zkeyInit = await zkeyUtils.readHeader(fdInit, sectionsInit, "groth16");

    if (  (!Scalar.eq(zkeyInit.q, zkey.q))
        ||(!Scalar.eq(zkeyInit.r, zkey.r))
        ||(zkeyInit.n8q != zkey.n8q)
        ||(zkeyInit.n8r != zkey.n8r))
    {
        console.log("INVALID:  Different curves");
        return false;
    }

    if (  (zkeyInit.nVars != zkey.nVars)
        ||(zkeyInit.nPublic !=  zkey.nPublic)
        ||(zkeyInit.domainSize != zkey.domainSize))
    {
        console.log("INVALID:  Different circuit parameters");
        return false;
    }

    if (!curve.G1.eq(zkey.vk_alpha_1, zkeyInit.vk_alpha_1)) {
        console.log("INVALID:  Invalid alpha1");
        return false;
    }
    if (!curve.G1.eq(zkey.vk_beta_1, zkeyInit.vk_beta_1)) {
        console.log("INVALID:  Invalid beta1");
        return false;
    }
    if (!curve.G2.eq(zkey.vk_beta_2, zkeyInit.vk_beta_2)) {
        console.log("INVALID:  Invalid beta2");
        return false;
    }
    if (!curve.G2.eq(zkey.vk_gamma_2, zkeyInit.vk_gamma_2)) {
        console.log("INVALID:  Invalid gamma2");
        return false;
    }
    if (!curve.G1.eq(zkey.vk_delta_1, curDelta)) {
        console.log("INVALID:  Invalud delta1");
        return false;
    }
    sr = await sameRatio(curve, curve.G1.g, curDelta, curve.G2.g, zkey.vk_delta_2);
    if (sr !== true) {
        console.log("INVALID:  Invalud delta2");
        return false;
    }

    const mpcParamsInit = await zkeyUtils.readMPCParams(fdInit, curve, sectionsInit);
    if (!misc.hashIsEqual(mpcParams.csHash, mpcParamsInit.csHash)) {
        console.log("INVALID:  Circuit does not match");
        return false;
    }

    // Check sizes of sections
    if (sections[8][0].size != sG1*(zkey.nVars-zkey.nPublic-1)) {
        console.log("INVALID:  Invalid L section size");
        return false;
    }

    if (sections[9][0].size != sG1*(zkey.domainSize)) {
        console.log("INVALID:  Invalid H section size");
        return false;
    }

    let ss;
    ss = await binFileUtils.sectionIsEqual(fd, sections, fdInit, sectionsInit, 3);
    if (!ss) {
        console.log("INVALID:  IC section is not identical");
        return false;
    }

    ss = await binFileUtils.sectionIsEqual(fd, sections, fdInit, sectionsInit, 4);
    if (!ss) {
        console.log("Coeffs section is not identical");
        return false;
    }

    ss = await binFileUtils.sectionIsEqual(fd, sections, fdInit, sectionsInit, 5);
    if (!ss) {
        console.log("A section is not identical");
        return false;
    }

    ss = await binFileUtils.sectionIsEqual(fd, sections, fdInit, sectionsInit, 6);
    if (!ss) {
        console.log("B1 section is not identical");
        return false;
    }

    ss = await binFileUtils.sectionIsEqual(fd, sections, fdInit, sectionsInit, 7);
    if (!ss) {
        console.log("B2 section is not identical");
        return false;
    }

    // Check L
    sr = await sectionHasSameRatio("G1", fdInit, sectionsInit, fd, sections, 8, zkey.vk_delta_2, zkeyInit.vk_delta_2, "L section");
    if (sr!==true) {
        console.log("L section does not match");
        return false;
    }

    // Check H
    sr = await sameRatioH();
    if (sr!==true) {
        console.log("H section does not match");
        return false;
    }


    return true;


    async function sectionHasSameRatio(groupName, fd1, sections1, fd2, sections2, idSection, g2sp, g2spx, sectionName) {
        const MAX_CHUNK_SIZE = 1<<20;
        const G = curve[groupName];
        const sG = G.F.n8*2;
        await binFileUtils.startReadUniqueSection(fd1, sections1, idSection);
        await binFileUtils.startReadUniqueSection(fd2, sections2, idSection);

        let R1 = G.zero;
        let R2 = G.zero;

        const nPoints = sections1[idSection][0].size / sG;

        for (let i=0; i<nPoints; i += MAX_CHUNK_SIZE) {
            if ((verbose)&&i) console.log(`${sectionName}:  ` + i);
            const n = Math.min(nPoints - i, MAX_CHUNK_SIZE);
            const bases1 = await fd1.read(n*sG);
            const bases2 = await fd2.read(n*sG);

            const scalars = new Uint8Array(4*n);
            crypto.randomFillSync(scalars);


            const r1 = await G.multiExpAffine(bases1, scalars);
            const r2 = await G.multiExpAffine(bases2, scalars);

            R1 = G.add(R1, r1);
            R2 = G.add(R2, r2);
        }
        await binFileUtils.endReadSection(fd1);
        await binFileUtils.endReadSection(fd2);

        sr = await sameRatio(curve, R1, R2, g2sp, g2spx);
        if (sr !== true) return false;

        return true;
    }

    async function sameRatioH() {
        const MAX_CHUNK_SIZE = 1<<20;
        const G = curve.G1;
        const sG = G.F.n8*2;

        const {fd: fdPTau, sections: sectionsPTau} = await binFileUtils.readBinFile(pTauFileName, "ptau", 1);

        let buff_r = new Uint8Array(zkey.domainSize * zkey.n8r);

        const seed= new Array(8);
        for (let i=0; i<8; i++) {
            seed[i] = crypto.randomBytes(4).readUInt32BE(0, true);
        }
        const rng = new ChaCha(seed);
        for (let i=0; i<zkey.domainSize-1; i++) {   // Note that last one is zero
            const e = curve.Fr.fromRng(rng);
            curve.Fr.toRprLE(buff_r, i*zkey.n8r, e);
        }

        let R1 = G.zero;
        for (let i=0; i<zkey.domainSize; i += MAX_CHUNK_SIZE) {
            if ((verbose)&&i) console.log(`H Verificaition(tau):  ${i}/${zkey.domainSize}`);
            const n = Math.min(zkey.domainSize - i, MAX_CHUNK_SIZE);

            const buff1 = await fdPTau.read(sG*n, sectionsPTau[2][0].p + zkey.domainSize*sG + i*MAX_CHUNK_SIZE*sG);
            const buff2 = await fdPTau.read(sG*n, sectionsPTau[2][0].p + i*MAX_CHUNK_SIZE*sG);

            const buffB = await batchSubstract(buff1, buff2);
            const buffS = buff_r.slice((i*MAX_CHUNK_SIZE)*zkey.n8r, (i*MAX_CHUNK_SIZE+n)*zkey.n8r);
            const r = await G.multiExpAffine(buffB, buffS);

            R1 = G.add(R1, r);
        }

        // Caluclate odd coeficients in transformed domain

        buff_r = await curve.Fr.batchToMontgomery(buff_r);
        // const first = curve.Fr.neg(curve.Fr.inv(curve.Fr.e(2)));
        // Works*2   const first = curve.Fr.neg(curve.Fr.e(2));
        const first = curve.Fr.neg(curve.Fr.e(2));
        // const inc = curve.Fr.inv(curve.PFr.w[zkey.power+1]);
        const inc = curve.PFr.w[zkey.power+1];
        buff_r = await curve.Fr.batchApplyKey(buff_r, first, inc);
        buff_r = await curve.Fr.fft(buff_r);
        buff_r = await curve.Fr.batchFromMontgomery(buff_r);

        await binFileUtils.startReadUniqueSection(fd, sections, 9);
        let R2 = G.zero;
        for (let i=0; i<zkey.domainSize; i += MAX_CHUNK_SIZE) {
            if ((verbose)&&i) console.log(`H Verificaition(lagrange):  ${i}/${zkey.domainSize}`);
            const n = Math.min(zkey.domainSize - i, MAX_CHUNK_SIZE);

            const buff = await fd.read(sG*n);
            const buffS = buff_r.slice((i*MAX_CHUNK_SIZE)*zkey.n8r, (i*MAX_CHUNK_SIZE+n)*zkey.n8r);
            const r = await G.multiExpAffine(buff, buffS);

            R2 = G.add(R2, r);
        }
        await binFileUtils.endReadSection(fd);

        sr = await sameRatio(curve, R1, R2, zkey.vk_delta_2, zkeyInit.vk_delta_2);
        if (sr !== true) return false;

        return true;

    }

    async function batchSubstract(buff1, buff2) {
        const sG = curve.G1.F.n8*2;
        const nPoints = buff1.byteLength / sG;
        const concurrency= curve.engine.concurrency;
        const nPointsPerThread = Math.floor(nPoints / concurrency);
        const opPromises = [];
        for (let i=0; i<concurrency; i++) {
            let n;
            if (i< concurrency-1) {
                n = nPointsPerThread;
            } else {
                n = nPoints - i*nPointsPerThread;
            }
            if (n==0) continue;

            const subBuff1 = buff1.slice(i*nPointsPerThread*sG1, (i*nPointsPerThread+n)*sG1);
            const subBuff2 = buff2.slice(i*nPointsPerThread*sG1, (i*nPointsPerThread+n)*sG1);
            opPromises.push(batchSubstractThread(subBuff1, subBuff2));
        }


        const result = await Promise.all(opPromises);

        const fullBuffOut = new Uint8Array(nPoints*sG);
        let p =0;
        for (let i=0; i<result.length; i++) {
            fullBuffOut.set(result[i][0], p);
            p+=result[i][0].byteLength;
        }

        return fullBuffOut;
    }


    async function batchSubstractThread(buff1, buff2) {
        const sG1 = curve.G1.F.n8*2;
        const sGmid = curve.G1.F.n8*3;
        const nPoints = buff1.byteLength/sG1;
        const task = [];
        task.push({cmd: "ALLOCSET", var: 0, buff: buff1});
        task.push({cmd: "ALLOCSET", var: 1, buff: buff2});
        task.push({cmd: "ALLOC", var: 2, len: nPoints*sGmid});
        for (let i=0; i<nPoints; i++) {
            task.push({
                cmd: "CALL",
                fnName: "g1m_subAffine",
                params: [
                    {var: 0, offset: i*sG1},
                    {var: 1, offset: i*sG1},
                    {var: 2, offset: i*sGmid},
                ]
            });
        }
        task.push({cmd: "CALL", fnName: "g1m_batchToAffine", params: [
            {var: 2},
            {val: nPoints},
            {var: 2},
        ]});
        task.push({cmd: "GET", out: 0, var: 2, len: nPoints*sG1});

        const res = await curve.engine.queueAction(task);

        return res;
    }

};


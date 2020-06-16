
// Format
// ======
// Header(1)
//      Prover Type 1 Groth
// HeaderGroth(2)
//      n8q
//      q
//      n8r
//      r
//      NVars
//      NPub
//      DomainSize  (multiple of 2
//      alpha1
//      beta1
//      delta1
//      beta2
//      gamma2
//      delta2
// IC(3)
// Coefs(4)
// PointsA(5)
// PointsB1(6)
// PointsB2(7)
// PointsC(8)
// PointsH(9)
// Contributions(10)


const Scalar = require("ffjavascript").Scalar;
const F1Field = require("ffjavascript").F1Field;
const assert = require("assert");
const binFileUtils = require("./binfileutils");

const getCurve = require("./curves").getCurveFromQ;
const {log2} = require("./misc");

async function writeHeader(fd, zkey) {

    // Write the header
    ///////////
    await binFileUtils.startWriteSection(fd, 1);
    await fd.writeULE32(1); // Groth
    await binFileUtils.endWriteSection(fd);

    // Write the Groth header section
    ///////////

    const curve = getCurve(zkey.q);

    await binFileUtils.startWriteSection(fd, 2);
    const primeQ = curve.q;
    const n8q = (Math.floor( (Scalar.bitLength(primeQ) - 1) / 64) +1)*8;

    const primeR = curve.r;
    const n8r = (Math.floor( (Scalar.bitLength(primeR) - 1) / 64) +1)*8;

    await fd.writeULE32(n8q);
    await binFileUtils.writeBigInt(fd, primeQ, n8q);
    await fd.writeULE32(n8r);
    await binFileUtils.writeBigInt(fd, primeR, n8r);
    await fd.writeULE32(zkey.nVars);                         // Total number of bars
    await fd.writeULE32(zkey.nPublic);                       // Total number of public vars (not including ONE)
    await fd.writeULE32(zkey.domainSize);                  // domainSize
    await writeG1(fd, curve, zkey.vk_alpha_1);
    await writeG1(fd, curve, zkey.vk_beta_1);
    await writeG2(fd, curve, zkey.vk_beta_2);
    await writeG2(fd, curve, zkey.vk_gamma_2);
    await writeG1(fd, curve, zkey.vk_delta_1);
    await writeG2(fd, curve, zkey.vk_delta_2);

    await binFileUtils.endWriteSection(fd);


}

async function writeZKey(fileName, zkey) {

    let curve = getCurve(zkey.q);

    const fd = await binFileUtils.createBinFile(fileName,"zkey", 1, 9);

    await writeHeader(fd, zkey);
    const n8r = (Math.floor( (Scalar.bitLength(zkey.r) - 1) / 64) +1)*8;
    const Rr = Scalar.mod(Scalar.shl(1, n8r*8), zkey.r);
    const R2r = Scalar.mod(Scalar.mul(Rr,Rr), zkey.r);

    // Write Pols (A and B (C can be ommited))
    ///////////

    zkey.ccoefs = zkey.ccoefs.filter(c => c.matrix<2);
    zkey.ccoefs.sort( (a,b) => a.constraint - b.constraint );
    await binFileUtils.startWriteSection(fd, 4);
    await fd.writeULE32(zkey.ccoefs.length);
    for (let i=0; i<zkey.ccoefs.length; i++) {
        const coef = zkey.ccoefs[i];
        await fd.writeULE32(coef.matrix);
        await fd.writeULE32(coef.constraint);
        await fd.writeULE32(coef.signal);
        await writeFr2(coef.value);
    }
    await binFileUtils.endWriteSection(fd);


    // Write IC Section
    ///////////
    await binFileUtils.startWriteSection(fd, 3);
    for (let i=0; i<= zkey.nPublic; i++) {
        await writeG1(fd, curve, zkey.IC[i] );
    }
    await binFileUtils.endWriteSection(fd);


    // Write A
    ///////////
    await binFileUtils.startWriteSection(fd, 5);
    for (let i=0; i<zkey.nVars; i++) {
        await writeG1(fd, curve, zkey.A[i]);
    }
    await binFileUtils.endWriteSection(fd);

    // Write B1
    ///////////
    await binFileUtils.startWriteSection(fd, 6);
    for (let i=0; i<zkey.nVars; i++) {
        await writeG1(fd, curve, zkey.B1[i]);
    }
    await binFileUtils.endWriteSection(fd);

    // Write B2
    ///////////
    await binFileUtils.startWriteSection(fd, 7);
    for (let i=0; i<zkey.nVars; i++) {
        await writeG2(fd, curve, zkey.B2[i]);
    }
    await binFileUtils.endWriteSection(fd);

    // Write C
    ///////////
    await binFileUtils.startWriteSection(fd, 8);
    for (let i=zkey.nPublic+1; i<zkey.nVars; i++) {
        await writeG1(fd, curve, zkey.C[i]);
    }
    await binFileUtils.endWriteSection(fd);


    // Write H points
    ///////////
    await binFileUtils.startWriteSection(fd, 9);
    for (let i=0; i<zkey.domainSize; i++) {
        await writeG1(fd, curve, zkey.hExps[i]);
    }
    await binFileUtils.endWriteSection(fd);

    await fd.close();

    async function writeFr2(n) {
        // Convert to montgomery
        n = Scalar.mod( Scalar.mul(n, R2r), zkey.r);

        await binFileUtils.writeBigInt(fd, n, n8r);
    }

}

async function writeG1(fd, curve, p) {
    const buff = new Uint8Array(curve.G1.F.n8*2);
    curve.G1.toRprLEM(buff, 0, p);
    await fd.write(buff);
}

async function writeG2(fd, curve, p) {
    const buff = new Uint8Array(curve.G2.F.n8*2);
    curve.G2.toRprLEM(buff, 0, p);
    await fd.write(buff);
}

async function readG1(fd, curve) {
    const buff = await fd.read(curve.G1.F.n8*2);
    return curve.G1.fromRprLEM(buff, 0);
}

async function readG2(fd, curve) {
    const buff = await fd.read(curve.G2.F.n8*2);
    return curve.G2.fromRprLEM(buff, 0);
}



async function readHeader(fd, sections, protocol) {
    if (protocol != "groth16") throw new Error("Protocol not supported: "+protocol);

    const zkey = {};

    // Read Header
    /////////////////////
    await binFileUtils.startReadUniqueSection(fd, sections, 1);
    const protocolId = await fd.readULE32();
    if (protocolId != 1) assert("File is not groth");
    zkey.protocol = "groth16";
    await binFileUtils.endReadSection(fd);

    // Read Groth Header
    /////////////////////
    await binFileUtils.startReadUniqueSection(fd, sections, 2);
    const n8q = await fd.readULE32();
    zkey.n8q = n8q;
    zkey.q = await binFileUtils.readBigInt(fd, n8q);

    const n8r = await fd.readULE32();
    zkey.n8r = n8r;
    zkey.r = await binFileUtils.readBigInt(fd, n8r);

    let curve = getCurve(zkey.q);

    zkey.nVars = await fd.readULE32();
    zkey.nPublic = await fd.readULE32();
    zkey.domainSize = await fd.readULE32();
    zkey.power = log2(zkey.domainSize);
    zkey.vk_alpha_1 = await readG1(fd, curve);
    zkey.vk_beta_1 = await readG1(fd, curve);
    zkey.vk_beta_2 = await readG2(fd, curve);
    zkey.vk_gamma_2 = await readG2(fd, curve);
    zkey.vk_delta_1 = await readG1(fd, curve);
    zkey.vk_delta_2 = await readG2(fd, curve);
    await binFileUtils.endReadSection(fd);

    return zkey;

}

async function readZKey(fileName) {
    const {fd, sections} = await binFileUtils.readBinFile(fileName, "zkey", 1);

    const zkey = await readHeader(fd, sections, "groth16");

    const Fr = new F1Field(zkey.r);
    const Rr = Scalar.mod(Scalar.shl(1, zkey.n8r*8), zkey.r);
    const Rri = Fr.inv(Rr);
    const Rri2 = Fr.mul(Rri, Rri);

    let curve = getCurve(zkey.q);

    // Read IC Section
    ///////////
    await binFileUtils.startReadUniqueSection(fd, sections, 3);
    zkey.IC = [];
    for (let i=0; i<= zkey.nPublic; i++) {
        const P = await readG1(fd, curve);
        zkey.IC.push(P);
    }
    await binFileUtils.endReadSection(fd);


    // Read Coefs
    ///////////
    await binFileUtils.startReadUniqueSection(fd, sections, 4);
    const nCCoefs = await fd.readULE32();
    zkey.ccoefs = [];
    for (let i=0; i<nCCoefs; i++) {
        const m = await fd.readULE32();
        const c = await fd.readULE32();
        const s = await fd.readULE32();
        const v = await readFr2();
        zkey.ccoefs.push({
            matrix: m,
            constraint: c,
            signal: s,
            value: v
        });
    }
    await binFileUtils.endReadSection(fd);

    // Read A points
    ///////////
    await binFileUtils.startReadUniqueSection(fd, sections, 5);
    zkey.A = [];
    for (let i=0; i<zkey.nVars; i++) {
        const A = await readG1(fd, curve);
        zkey.A[i] = A;
    }
    await binFileUtils.endReadSection(fd);


    // Read B1
    ///////////
    await binFileUtils.startReadUniqueSection(fd, sections, 6);
    zkey.B1 = [];
    for (let i=0; i<zkey.nVars; i++) {
        const B1 = await readG1(fd, curve);

        zkey.B1[i] = B1;
    }
    await binFileUtils.endReadSection(fd);


    // Read B2 points
    ///////////
    await binFileUtils.startReadUniqueSection(fd, sections, 7);
    zkey.B2 = [];
    for (let i=0; i<zkey.nVars; i++) {
        const B2 = await readG2(fd, curve);
        zkey.B2[i] = B2;
    }
    await binFileUtils.endReadSection(fd);


    // Read C points
    ///////////
    await binFileUtils.startReadUniqueSection(fd, sections, 8);
    zkey.C = [];
    for (let i=zkey.nPublic+1; i<zkey.nVars; i++) {
        const C = await readG1(fd, curve);

        zkey.C[i] = C;
    }
    await binFileUtils.endReadSection(fd);


    // Read H points
    ///////////
    await binFileUtils.startReadUniqueSection(fd, sections, 9);
    zkey.hExps = [];
    for (let i=0; i<zkey.domainSize; i++) {
        const H = await readG1(fd, curve);
        zkey.hExps.push(H);
    }
    await binFileUtils.endReadSection(fd);

    await fd.close();

    return zkey;

    async function readFr2() {
        const n = await binFileUtils.readBigInt(fd, zkey.n8r);
        return Fr.mul(n, Rri2);
    }

}


async function readContribution(fd, curve) {
    const c = {delta:{}};
    c.deltaAfter = await readG1(fd, curve);
    c.delta.g1_s = await readG1(fd, curve);
    c.delta.g1_sx = await readG1(fd, curve);
    c.delta.g2_spx = await readG2(fd, curve);
    c.transcript = await fd.read(64);
    c.type = await fd.readULE32();

    const paramLength = await fd.readULE32();
    const curPos = fd.pos;
    let lastType =0;
    while (fd.pos-curPos < paramLength) {
        const buffType = await fd.read(1);
        if (buffType[0]<= lastType) throw new Error("Parameters in the contribution must be sorted");
        lastType = buffType[0];
        if (buffType[0]==1) {     // Name
            const buffLen = await fd.read(1);
            const buffStr = await fd.read(buffLen[0]);
            c.name = new TextDecoder().decode(buffStr);
        } else if (buffType[0]==2) {
            const buffExp = await fd.read(1);
            c.numIterationsExp = buffExp[0];
        } else if (buffType[0]==3) {
            const buffLen = await fd.read(1);
            c.beaconHash = await fd.read(buffLen[0]);
        } else {
            throw new Error("Parameter not recognized");
        }
    }
    if (fd.pos != curPos + paramLength) {
        throw new Error("Parametes do not match");
    }

    return c;
}


async function readMPCParams(fd, curve, sections) {
    await binFileUtils.startReadUniqueSection(fd, sections, 10);
    const res = { contributions: []};
    res.csHash = await fd.read(64);
    const n = await fd.readULE32();
    for (let i=0; i<n; i++) {
        const c = await readContribution(fd, curve);
        res.contributions.push(c);
    }
    await binFileUtils.endReadSection(fd);

    return res;
}

async function writeContribution(fd, curve, c) {
    await writeG1(fd, curve, c.deltaAfter);
    await writeG1(fd, curve, c.delta.g1_s);
    await writeG1(fd, curve, c.delta.g1_sx);
    await writeG2(fd, curve, c.delta.g2_spx);
    await fd.write(c.transcript);
    await fd.writeULE32(c.type || 0);

    const params = [];
    if (c.name) {
        params.push(1);      // Param Name
        const nameData = new TextEncoder("utf-8").encode(c.name.substring(0,64));
        params.push(nameData.byteLength);
        for (let i=0; i<nameData.byteLength; i++) params.push(nameData[i]);
    }
    if (c.type == 1) {
        params.push(2);      // Param numIterationsExp
        params.push(c.numIterationsExp);

        params.push(3);      // Beacon Hash
        params.push(c.beaconHash.byteLength);
        for (let i=0; i<c.beaconHash.byteLength; i++) params.push(c.beaconHash[i]);
    }
    if (params.length>0) {
        const paramsBuff = new Uint8Array(params);
        await fd.writeULE32(paramsBuff.byteLength);
        await fd.write(paramsBuff);
    } else {
        await fd.writeULE32(0);
    }

}

async function writeMPCParams(fd, curve, mpcParams) {
    await binFileUtils.startWriteSection(fd, 10);
    await fd.write(mpcParams.csHash);
    await fd.writeULE32(mpcParams.contributions.length);
    for (let i=0; i<mpcParams.contributions.length; i++) {
        await writeContribution(fd, curve,mpcParams.contributions[i]);
    }
    await binFileUtils.endWriteSection(fd);
}

function hashG1(hasher, curve, p) {
    const buff = new Uint8Array(curve.G1.F.n8*2);
    curve.G1.toRprUncompressed(buff, 0, p);
    hasher.update(buff);
}

function hashG2(hasher,curve, p) {
    const buff = new Uint8Array(curve.G2.F.n8*2);
    curve.G2.toRprUncompressed(buff, 0, p);
    hasher.update(buff);
}

function hashPubKey(hasher, curve, c) {
    hashG1(hasher, curve, c.deltaAfter);
    hashG1(hasher, curve, c.delta.g1_s);
    hashG1(hasher, curve, c.delta.g1_sx);
    hashG2(hasher, curve, c.delta.g2_spx);
    hasher.update(c.transcript);
}


module.exports.readHeader = readHeader;
module.exports.writeHeader = writeHeader;
module.exports.read = readZKey;
module.exports.write = writeZKey;
module.exports.readMPCParams = readMPCParams;
module.exports.writeMPCParams = writeMPCParams;
module.exports.hashG1 = hashG1;
module.exports.hashG2 = hashG2;
module.exports.hashPubKey = hashPubKey;

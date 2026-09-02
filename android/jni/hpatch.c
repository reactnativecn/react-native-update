// hpatch.c
// Copyright 2021 housisong, All rights reserved
#include "hpatch.h"
#include "HDiffPatch/libHDiffPatch/HPatch/patch.h"
#include "HDiffPatch/file_for_patch.h"

//#define _CompressPlugin_zlib
//#define _CompressPlugin_bz2
#define _CompressPlugin_lzma
#define _CompressPlugin_lzma2
#define _IsNeedIncludeDefaultCompressHead 0
#include "lzma/C/LzmaDec.h"
#include "lzma/C/Lzma2Dec.h"
#include "HDiffPatch/decompress_plugin_demo.h"

#define kMaxLoadMemOldSize ((1<<20)*8)

// LZMA/LZMA2 declare their dictionary size inside the compressed stream, i.e.
// in attacker-controlled patch bytes, and LzmaDec_Allocate() allocates it
// verbatim — up to 4 GB. The plugins live in the HDiffPatch submodule, so the
// cap is applied here by wrapping open(): decode the declared dictionary the
// way the decoder does and refuse anything above kMaxLzmaDictSize before any
// allocation happens. hdiffz defaults to an 8 MB dictionary and reduces it to
// the input size (compress_plugin_demo.h reduceSize), so real patches sit far
// below the cap; a refused stream fails the patch cleanly (kHPatch_error_patch)
// and the caller falls back to the full package.
#define kMaxLzmaDictSize ((hpatch_uint32_t)((1<<20)*128))

#define  _check(v,errorType) do{ \
    if (!(v)){ if (result==kHPatch_ok) result=errorType; if (!_isInClear){ goto _clear; }; } }while(0)

#ifdef  _CompressPlugin_lzma
static hpatch_decompressHandle _capped_lzma_open(hpatch_TDecompress* decompressPlugin,
                                                 hpatch_StreamPos_t dataSize,
                                                 const hpatch_TStreamInput* codeStream,
                                                 hpatch_StreamPos_t code_begin,
                                                 hpatch_StreamPos_t code_end){
    // stream layout (see _lzma_open): propsSize byte, then propsSize bytes of
    // LZMA props whose bytes 1..4 hold the little-endian dictionary size.
    unsigned char propsSize=0;
    unsigned char props[LZMA_PROPS_SIZE];
    hpatch_uint32_t dicSize;
    if (code_end-code_begin<1) return 0;
    if (!codeStream->read(codeStream,code_begin,&propsSize,&propsSize+1)) return 0;
    if ((propsSize<LZMA_PROPS_SIZE)||(propsSize>code_end-code_begin-1)) return 0;
    if (!codeStream->read(codeStream,code_begin+1,props,props+LZMA_PROPS_SIZE)) return 0;
    dicSize=((hpatch_uint32_t)props[1])|(((hpatch_uint32_t)props[2])<<8)
           |(((hpatch_uint32_t)props[3])<<16)|(((hpatch_uint32_t)props[4])<<24);
    if (dicSize>kMaxLzmaDictSize) return 0;
    return lzmaDecompressPlugin.open(decompressPlugin,dataSize,codeStream,code_begin,code_end);
}
static hpatch_TDecompress cappedLzmaDecompressPlugin={_lzma_is_can_open,_capped_lzma_open,
                                                      _lzma_close,_lzma_decompress_part};
#endif
#ifdef  _CompressPlugin_lzma2
static hpatch_decompressHandle _capped_lzma2_open(hpatch_TDecompress* decompressPlugin,
                                                  hpatch_StreamPos_t dataSize,
                                                  const hpatch_TStreamInput* codeStream,
                                                  hpatch_StreamPos_t code_begin,
                                                  hpatch_StreamPos_t code_end){
    // stream layout (see _lzma2_open): a single LZMA2 property byte encodes
    // the dictionary size (Lzma2Dec_GetOldProps): 40 means 4 GB - 1.
    unsigned char prop=0;
    hpatch_uint32_t dicSize;
    if (code_end-code_begin<1) return 0;
    if (!codeStream->read(codeStream,code_begin,&prop,&prop+1)) return 0;
    if (prop>40) return 0;
    dicSize=(prop==40)?0xFFFFFFFF:(((hpatch_uint32_t)2|(prop&1))<<(prop/2+11));
    if (dicSize>kMaxLzmaDictSize) return 0;
    return lzma2DecompressPlugin.open(decompressPlugin,dataSize,codeStream,code_begin,code_end);
}
static hpatch_TDecompress cappedLzma2DecompressPlugin={_lzma2_is_can_open,_capped_lzma2_open,
                                                       _lzma2_close,_lzma2_decompress_part};
#endif

static hpatch_TDecompress* getDecompressPlugin(const char* compressType){
#ifdef  _CompressPlugin_zlib
    if (zlibDecompressPlugin.is_can_open(compressType))
        return &zlibDecompressPlugin;
#endif
#ifdef  _CompressPlugin_bz2
    if (bz2DecompressPlugin.is_can_open(compressType))
        return &bz2DecompressPlugin;
#endif
#ifdef  _CompressPlugin_lzma
    if (cappedLzmaDecompressPlugin.is_can_open(compressType))
        return &cappedLzmaDecompressPlugin;
#endif
#ifdef  _CompressPlugin_lzma2
    if (cappedLzma2DecompressPlugin.is_can_open(compressType))
        return &cappedLzma2DecompressPlugin;
#endif
    return 0;
}
static int hpatch_by_stream(const hpatch_TStreamInput* old,hpatch_BOOL isLoadOldAllToMem,const hpatch_TStreamInput* pat,
                            hpatch_TStreamOutput* out_new,const hpatch_singleCompressedDiffInfo* patInfo){
    int     result=kHPatch_ok;
    int     _isInClear=hpatch_FALSE;
    hpatch_TDecompress* decompressPlugin=0;
    uint8_t* temp_cache=0;
    size_t temp_cache_size;
    hpatch_singleCompressedDiffInfo _patinfo;
    hpatch_TStreamInput _old;
    {// info
        if (!patInfo){
            _check(getSingleCompressedDiffInfo(&_patinfo,pat,0),kHPatch_error_info);
            patInfo=&_patinfo;
        }
        _check(old->streamSize==patInfo->oldDataSize,kHPatch_error_old_size);
        _check(out_new->streamSize>=patInfo->newDataSize,kHPatch_error_new_size);
        out_new->streamSize=patInfo->newDataSize;
        // v5 writer 可能保留 lzma2 标签但以 RAW 存储小 diff;compressedSize==0
        // 才是格式里的未压缩判据,不能按标签强行走解压。
        if ((strlen(patInfo->compressType)>0)&&(patInfo->compressedSize>0)){
            decompressPlugin=getDecompressPlugin(patInfo->compressType);
            _check(decompressPlugin,kHPatch_error_compressType);
        }
    }
    {// mem
        size_t mem_size;
        size_t oldSize=(size_t)old->streamSize;
        isLoadOldAllToMem=isLoadOldAllToMem&&(old->streamSize<=kMaxLoadMemOldSize);
        temp_cache_size=patInfo->stepMemSize+hpatch_kFileIOBufBetterSize*3;
        mem_size=temp_cache_size+(isLoadOldAllToMem?oldSize:0);
        temp_cache=malloc(mem_size);
        _check(temp_cache,kHPatch_error_malloc);
        if (isLoadOldAllToMem){//load old to mem
            uint8_t* oldMem=temp_cache+temp_cache_size;
            _check(old->read(old,0,oldMem,oldMem+oldSize),kHPatch_error_old_fread);
            mem_as_hStreamInput(&_old,oldMem,oldMem+oldSize);
            old=&_old;
        }
    }

    _check(patch_single_compressed_diff(out_new,old,pat,patInfo->diffDataPos,
               patInfo->uncompressedSize,decompressPlugin,patInfo->coverCount,
               patInfo->stepMemSize,temp_cache,temp_cache+temp_cache_size),kHPatch_error_patch);

_clear:
    _isInClear=hpatch_TRUE;
    if (temp_cache){ free(temp_cache); temp_cache=0; }
    return result;
}

// HDIFF13(diffStream 产物,v2 轨道的大 bundle patch):流式应用,
// 内存 = 解压缓存 + IO 缓冲(+ old ≤ 8MB 时的整载优化),与 single 路径同级。
static int hpatch_v13_by_stream(const hpatch_TStreamInput* old,hpatch_BOOL isLoadOldAllToMem,
                                const hpatch_TStreamInput* pat,hpatch_TStreamOutput* out_new){
    int     result=kHPatch_ok;
    int     _isInClear=hpatch_FALSE;
    hpatch_TDecompress* decompressPlugin=0;
    uint8_t* temp_cache=0;
    size_t temp_cache_size;
    hpatch_compressedDiffInfo patInfo;
    hpatch_TStreamInput _old;
    {// info
        _check(getCompressedDiffInfo(&patInfo,pat),kHPatch_error_info);
        _check(old->streamSize==patInfo.oldDataSize,kHPatch_error_old_size);
        _check(out_new->streamSize>=patInfo.newDataSize,kHPatch_error_new_size);
        out_new->streamSize=patInfo.newDataSize;
        if (strlen(patInfo.compressType)>0){
            decompressPlugin=getDecompressPlugin(patInfo.compressType);
            _check(decompressPlugin,kHPatch_error_compressType);
        }
    }
    {// mem
        size_t mem_size;
        size_t oldSize=(size_t)old->streamSize;
        isLoadOldAllToMem=isLoadOldAllToMem&&(old->streamSize<=kMaxLoadMemOldSize);
        temp_cache_size=hpatch_kStreamCacheSize*8+hpatch_kFileIOBufBetterSize*3;
        mem_size=temp_cache_size+(isLoadOldAllToMem?oldSize:0);
        temp_cache=malloc(mem_size);
        _check(temp_cache,kHPatch_error_malloc);
        if (isLoadOldAllToMem){//load old to mem
            uint8_t* oldMem=temp_cache+temp_cache_size;
            _check(old->read(old,0,oldMem,oldMem+oldSize),kHPatch_error_old_fread);
            mem_as_hStreamInput(&_old,oldMem,oldMem+oldSize);
            old=&_old;
        }
    }

    _check(patch_decompress_with_cache(out_new,old,pat,decompressPlugin,
               temp_cache,temp_cache+temp_cache_size),kHPatch_error_patch);

_clear:
    _isInClear=hpatch_TRUE;
    if (temp_cache){ free(temp_cache); temp_cache=0; }
    return result;
}

int hpatch_by_file(const char* oldfile, const char* newfile, const char* patchfile){
    int     result=kHPatch_ok;
    int     _isInClear=hpatch_FALSE;
    int     patch_result;
    hpatch_singleCompressedDiffInfo singleInfo;
    hpatch_TFileStreamInput oldStream;
    hpatch_TFileStreamInput patStream;
    hpatch_TFileStreamOutput newStream;
    hpatch_TFileStreamInput_init(&oldStream);
    hpatch_TFileStreamInput_init(&patStream);
    hpatch_TFileStreamOutput_init(&newStream);

    _check(hpatch_TFileStreamInput_open(&oldStream,oldfile),kHPatch_error_old_fopen);
    _check(hpatch_TFileStreamInput_open(&patStream,patchfile),kHPatch_error_pat_fopen);
    _check(hpatch_TFileStreamOutput_open(&newStream,newfile,~(hpatch_StreamPos_t)0),kHPatch_error_new_fopen);

    // 按 patch 头自动分派格式:single(HDIFFSF20,现状)或 stream(HDIFF13,
    // v2 轨道大 bundle)。老客户端只会收到 single;能力门控在服务端。
    if (getSingleCompressedDiffInfo(&singleInfo,&patStream.base,0)){
        patch_result=hpatch_by_stream(&oldStream.base,hpatch_TRUE,&patStream.base,&newStream.base,&singleInfo);
    }else{
        patch_result=hpatch_v13_by_stream(&oldStream.base,hpatch_TRUE,&patStream.base,&newStream.base);
    }
    if (patch_result!=kHPatch_ok){
        _check(!oldStream.fileError,kHPatch_error_old_fread);
        _check(!patStream.fileError,kHPatch_error_pat_fread);
        _check(!newStream.fileError,kHPatch_error_new_fwrite);
        _check(hpatch_FALSE,patch_result);
    }

_clear:
    _isInClear=hpatch_TRUE;
    _check(hpatch_TFileStreamInput_close(&oldStream),kHPatch_error_old_fclose);
    _check(hpatch_TFileStreamInput_close(&patStream),kHPatch_error_pat_fclose);
    _check(hpatch_TFileStreamOutput_close(&newStream),kHPatch_error_new_fclose);
    return result;
}

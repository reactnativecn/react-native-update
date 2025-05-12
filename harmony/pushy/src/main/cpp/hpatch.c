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

#define  _check(v,errorType) do{ \
    if (!(v)){ if (result==kHPatch_ok) result=errorType; if (!_isInClear){ goto _clear; }; } }while(0)

int hpatch_getInfo_by_mem(hpatch_singleCompressedDiffInfo* out_patinfo,
                          const uint8_t* pat,size_t patsize){
    hpatch_TStreamInput patStream;
    mem_as_hStreamInput(&patStream,pat,pat+patsize);
    if (!getSingleCompressedDiffInfo(out_patinfo,&patStream,0))
        return kHPatch_error_info;//data error;
    return kHPatch_ok; //ok
}

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
    if (lzmaDecompressPlugin.is_can_open(compressType))
        return &lzmaDecompressPlugin;
#endif
#ifdef  _CompressPlugin_lzma2
    if (lzma2DecompressPlugin.is_can_open(compressType))
        return &lzma2DecompressPlugin;
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
        if (strlen(patInfo->compressType)>0){
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

int hpatch_by_mem(const uint8_t* old,size_t oldsize,uint8_t* newBuf,size_t newsize,
                  const uint8_t* pat,size_t patsize,const hpatch_singleCompressedDiffInfo* patInfo){
    hpatch_TStreamInput oldStream;
    hpatch_TStreamInput patStream;
    hpatch_TStreamOutput newStream;
    mem_as_hStreamInput(&oldStream,old,old+oldsize);
    mem_as_hStreamInput(&patStream,pat,pat+patsize);
    mem_as_hStreamOutput(&newStream,newBuf,newBuf+newsize);
    return hpatch_by_stream(&oldStream,hpatch_FALSE,&patStream,&newStream,patInfo);
}

int hpatch_by_file(const char* oldfile, const char* newfile, const char* patchfile){
    int     result=kHPatch_ok;
    int     _isInClear=hpatch_FALSE;
    int     patch_result;
    hpatch_TFileStreamInput oldStream;
    hpatch_TFileStreamInput patStream;
    hpatch_TFileStreamOutput newStream;
    hpatch_TFileStreamInput_init(&oldStream);
    hpatch_TFileStreamInput_init(&patStream);
    hpatch_TFileStreamOutput_init(&newStream);

    _check(hpatch_TFileStreamInput_open(&oldStream,oldfile),kHPatch_error_old_fopen);
    _check(hpatch_TFileStreamInput_open(&patStream,patchfile),kHPatch_error_pat_fopen);
    _check(hpatch_TFileStreamOutput_open(&newStream,newfile,~(hpatch_StreamPos_t)0),kHPatch_error_new_fopen);

    patch_result=hpatch_by_stream(&oldStream.base,hpatch_TRUE,&patStream.base,&newStream.base,0);
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

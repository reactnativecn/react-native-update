// hpatch.h
// import HDiffPatch, support patchData created by "hdiffz -SD -c-lzma2 oldfile newfile patchfile"
// Copyright 2021 housisong, All rights reserved

#ifndef HDIFFPATCH_PATCH_H
#define HDIFFPATCH_PATCH_H
# include <stdint.h> //for uint8_t
#include "HDiffPatch/libHDiffPatch/HPatch/patch_types.h" //for hpatch_singleCompressedDiffInfo
#ifdef __cplusplus
extern "C" {
#endif

//result
enum {
    kHPatch_ok                  = 0,
    kHPatch_error_malloc        =-1,
    kHPatch_error_info          =-2,
    kHPatch_error_compressType  =-3,
    kHPatch_error_patch         =-4,
    kHPatch_error_old_fopen     =-5,
    kHPatch_error_old_fread     =-6,
    kHPatch_error_old_fclose    =-7,
    kHPatch_error_pat_fopen     =-8,
    kHPatch_error_pat_fread     =-9,
    kHPatch_error_pat_fclose    =-10,
    kHPatch_error_new_fopen     =-11,
    kHPatch_error_new_fwrite    =-12,
    kHPatch_error_new_fclose    =-13,
    kHPatch_error_old_size      =-14,
    kHPatch_error_new_size      =-15,
};

int hpatch_getInfo_by_mem(hpatch_singleCompressedDiffInfo* out_patinfo,
                          const uint8_t* pat,size_t patsize);

//patInfo can NULL
int hpatch_by_mem(const uint8_t* old,size_t oldsize, uint8_t* newBuf,size_t newsize,
                  const uint8_t* pat,size_t patsize,const hpatch_singleCompressedDiffInfo* patInfo);
int hpatch_by_file(const char* oldfile, const char* newfile, const char* patchfile);

#ifdef __cplusplus
}
#endif
#endif //HDIFFPATCH_PATCH_H

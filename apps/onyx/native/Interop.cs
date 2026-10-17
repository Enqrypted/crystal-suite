// Declarations for the Windows APIs Onyx's helper uses: Direct3D 11 / DXGI, Windows.Graphics.Capture interop,
// Media Foundation (transforms, samples, buffers, media types) and WASAPI. COM interfaces list every method in
// vtable order; methods Onyx never calls are placeholders that only reserve their slot.
using System;
using System.Runtime.InteropServices;

namespace Onyx
{
    static class HR
    {
        public const int S_OK = 0;
        public const int MF_E_TRANSFORM_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);
        public const int MF_E_TRANSFORM_STREAM_CHANGE = unchecked((int)0xC00D6D61);
        public const int MF_E_NO_EVENTS_AVAILABLE = unchecked((int)0xC00D3E80);
        public const int MF_E_NOTACCEPTING = unchecked((int)0xC00D36B5);
        public const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
        public static void Check(int hr, string what)
        {
            if (hr < 0) throw new COMException(what + " failed (0x" + hr.ToString("X8") + ")", hr);
        }
    }

    // ---------------------------------------------------------------- GUIDs (fields so they can go by ref)
    static class G
    {
        public static Guid MFMediaType_Video = new Guid("73646976-0000-0010-8000-00AA00389B71");
        public static Guid MFMediaType_Audio = new Guid("73647561-0000-0010-8000-00AA00389B71");
        public static Guid MFVideoFormat_ARGB32 = new Guid("00000015-0000-0010-8000-00AA00389B71");
        public static Guid MFVideoFormat_RGB32 = new Guid("00000016-0000-0010-8000-00AA00389B71");
        public static Guid MFVideoFormat_NV12 = new Guid("3231564E-0000-0010-8000-00AA00389B71");
        public static Guid MFVideoFormat_H264 = new Guid("34363248-0000-0010-8000-00AA00389B71");
        public static Guid MFAudioFormat_PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
        public static Guid MFAudioFormat_AAC = new Guid("00001610-0000-0010-8000-00AA00389B71");
        public static Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00AA00389B71");

        public static Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
        public static Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
        public static Guid MF_MT_FRAME_SIZE = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
        public static Guid MF_MT_FRAME_RATE = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
        public static Guid MF_MT_PIXEL_ASPECT_RATIO = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
        public static Guid MF_MT_INTERLACE_MODE = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
        public static Guid MF_MT_AVG_BITRATE = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
        public static Guid MF_MT_MPEG2_PROFILE = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
        public static Guid MF_MT_MPEG_SEQUENCE_HEADER = new Guid("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");
        public static Guid MF_MT_ALL_SAMPLES_INDEPENDENT = new Guid("c9173739-5e56-461c-b713-46fb995cb95f");
        public static Guid MF_MT_VIDEO_NOMINAL_RANGE = new Guid("c21b8ee5-b956-4071-8daf-325edf5cab11");
        public static Guid MF_MT_AUDIO_NUM_CHANNELS = new Guid("37e48bf5-645e-4c5b-89de-ada9e29b696a");
        public static Guid MF_MT_AUDIO_SAMPLES_PER_SECOND = new Guid("5faeeae7-0290-4c31-9e8a-c534f68d9dba");
        public static Guid MF_MT_AUDIO_BITS_PER_SAMPLE = new Guid("f2deb57f-40fa-4764-aa33-ed4f2d1ff669");
        public static Guid MF_MT_AUDIO_BLOCK_ALIGNMENT = new Guid("322de230-9eeb-43bd-ab7a-ff412251541d");
        public static Guid MF_MT_AUDIO_AVG_BYTES_PER_SECOND = new Guid("1aab75c8-cfef-451c-ab95-ac034b8e1731");
        public static Guid MF_MT_AAC_PAYLOAD_TYPE = new Guid("bfbabe79-7434-4d1c-94f0-72a3b9e17188");
        public static Guid MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION = new Guid("7632f0e6-9538-4d61-acda-ea29c8c14456");
        public static Guid MF_MT_USER_DATA = new Guid("b6bc765f-4c3b-40a4-bd51-2535b66fe09d");

        public static Guid MF_TRANSFORM_ASYNC = new Guid("f81a699a-649a-497d-8c73-29f8fed6ad7a");
        public static Guid MF_TRANSFORM_ASYNC_UNLOCK = new Guid("e5666d6b-3422-4eb6-a421-da7db1f8e207");
        public static Guid MF_SA_D3D11_AWARE = new Guid("206b4fc8-fcf9-4c51-afe3-9764369e33a0");
        public static Guid MF_LOW_LATENCY = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
        public static Guid MFT_ENUM_ADAPTER_LUID = new Guid("1d39518c-e220-4da8-a07f-ba172552d6b1");
        public static Guid MFT_FRIENDLY_NAME_Attribute = new Guid("314ffbae-5b41-4c95-9c19-4e7d586face3");
        public static Guid MFSampleExtension_CleanPoint = new Guid("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a");
        public static Guid MFT_CATEGORY_VIDEO_ENCODER = new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a");

        public static Guid CODECAPI_AVEncCommonRateControlMode = new Guid("1c0608e9-370c-4710-8a58-cb6181c42423");
        public static Guid CODECAPI_AVEncCommonMeanBitRate = new Guid("f7222374-2144-4815-b550-a37f8e12ee52");
        public static Guid CODECAPI_AVEncCommonMaxBitRate = new Guid("9651eae4-39b9-4ebf-85ef-d7f444ec7465");
        public static Guid CODECAPI_AVEncMPVGOPSize = new Guid("95f31b26-95a4-41aa-9303-246a7fc6eef1");
        public static Guid CODECAPI_AVEncMPVDefaultBPictureCount = new Guid("8d390aac-dc5c-4200-b57f-814d04babab2");
        public static Guid CODECAPI_AVLowLatencyMode = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
        public static Guid CODECAPI_AVEncVideoForceKeyFrame = new Guid("398c1b98-8353-475a-9ef2-8f265d260345");
        public static Guid CODECAPI_AVEncCommonQualityVsSpeed = new Guid("98332df8-03cd-476b-89fa-3f9e442dec9f");

        public static Guid IID_IMFTransform = new Guid("bf94c121-5b05-4e6f-8000-ba598961414d");
        public static Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        public static Guid IID_ID3D11Device = new Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140");
        public static Guid IID_IDXGIDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        public static Guid IID_IDXGIFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        public static Guid IID_ID3D10Multithread = new Guid("9B7E4E00-342C-4106-A19F-4F2704F689F0");
        public static Guid IID_IGraphicsCaptureItem = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
        public static Guid IID_IGraphicsCaptureItemInterop = new Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
        public static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        public static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        public static Guid MF_XVP_DISABLE_FRC = new Guid("2c0afa19-7a97-4d5a-9ee8-16d4fc518d8c");
        public static Guid CLSID_VideoProcessorMFT = new Guid("88753B26-5B24-49BD-B2E7-0C445C78C982");
        public static Guid CLSID_AACMFTEncoder = new Guid("93AF0C51-2275-45d2-A35B-F2BA21CAED00");
        public static Guid CLSID_MSH264EncoderMFT = new Guid("6CA50344-051A-4DED-9779-A43305165E35");
    }

    static class MFT
    {
        public const int OUTPUT_DATA_BUFFER_INCOMPLETE = 0x01000000;
        public const int MESSAGE_COMMAND_FLUSH = 0;
        public const int MESSAGE_COMMAND_DRAIN = 1;
        public const int MESSAGE_SET_D3D_MANAGER = 2;
        public const int MESSAGE_NOTIFY_BEGIN_STREAMING = 0x10000000;
        public const int MESSAGE_NOTIFY_END_STREAMING = 0x10000001;
        public const int MESSAGE_NOTIFY_END_OF_STREAM = 0x10000002;
        public const int MESSAGE_NOTIFY_START_OF_STREAM = 0x10000003;
        public const int OUTPUT_STREAM_PROVIDES_SAMPLES = 0x100;
        public const int OUTPUT_STREAM_CAN_PROVIDE_SAMPLES = 0x200;
        public const int ENUM_FLAG_SYNCMFT = 0x1;
        public const int ENUM_FLAG_ASYNCMFT = 0x2;
        public const int ENUM_FLAG_HARDWARE = 0x4;
        public const int ENUM_FLAG_SORTANDFILTER = 0x40;
        public const int METransformNeedInput = 601;
        public const int METransformHaveOutput = 602;
        public const int METransformDrainComplete = 603;
        public const int MF_EVENT_FLAG_NO_WAIT = 1;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MFT_REGISTER_TYPE_INFO { public Guid guidMajorType; public Guid guidSubtype; }

    [StructLayout(LayoutKind.Sequential)]
    struct MFT_INPUT_STREAM_INFO { public long hnsMaxLatency; public int dwFlags; public int cbSize; public int cbMaxLookahead; public int cbAlignment; }

    [StructLayout(LayoutKind.Sequential)]
    struct MFT_OUTPUT_STREAM_INFO { public int dwFlags; public int cbSize; public int cbAlignment; }

    [StructLayout(LayoutKind.Sequential)]
    struct MFT_OUTPUT_DATA_BUFFER { public int dwStreamID; public IntPtr pSample; public int dwStatus; public IntPtr pEvents; }

    // ---------------------------------------------------------------- Media Foundation interfaces
    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFAttributes
    {
        [PreserveSig] int GetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int GetItemType([In] ref Guid key, out int type);
        [PreserveSig] int CompareItem([In] ref Guid key, IntPtr value, out int result);
        [PreserveSig] int Compare(IntPtr theirs, int matchType, out int result);
        [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
        [PreserveSig] int GetUINT64([In] ref Guid key, out long value);
        [PreserveSig] int GetDouble([In] ref Guid key, out double value);
        [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
        [PreserveSig] int GetStringLength([In] ref Guid key, out int length);
        [PreserveSig] int GetString([In] ref Guid key, IntPtr buffer, int size, IntPtr length);
        [PreserveSig] int GetAllocatedString([In] ref Guid key, out IntPtr value, out int length);
        [PreserveSig] int GetBlobSize([In] ref Guid key, out int size);
        [PreserveSig] int GetBlob([In] ref Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size, out int written);
        [PreserveSig] int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out int size);
        [PreserveSig] int GetUnknown([In] ref Guid key, [In] ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem([In] ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        [PreserveSig] int SetUINT64([In] ref Guid key, long value);
        [PreserveSig] int SetDouble([In] ref Guid key, double value);
        [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
        [PreserveSig] int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob([In] ref Guid key, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size);
        [PreserveSig] int SetUnknown([In] ref Guid key, IntPtr value);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetItemByIndex(int index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
    }

    [ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaType
    {
        [PreserveSig] int GetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int GetItemType([In] ref Guid key, out int type);
        [PreserveSig] int CompareItem([In] ref Guid key, IntPtr value, out int result);
        [PreserveSig] int Compare(IntPtr theirs, int matchType, out int result);
        [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
        [PreserveSig] int GetUINT64([In] ref Guid key, out long value);
        [PreserveSig] int GetDouble([In] ref Guid key, out double value);
        [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
        [PreserveSig] int GetStringLength([In] ref Guid key, out int length);
        [PreserveSig] int GetString([In] ref Guid key, IntPtr buffer, int size, IntPtr length);
        [PreserveSig] int GetAllocatedString([In] ref Guid key, out IntPtr value, out int length);
        [PreserveSig] int GetBlobSize([In] ref Guid key, out int size);
        [PreserveSig] int GetBlob([In] ref Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size, out int written);
        [PreserveSig] int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out int size);
        [PreserveSig] int GetUnknown([In] ref Guid key, [In] ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem([In] ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        [PreserveSig] int SetUINT64([In] ref Guid key, long value);
        [PreserveSig] int SetDouble([In] ref Guid key, double value);
        [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
        [PreserveSig] int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob([In] ref Guid key, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size);
        [PreserveSig] int SetUnknown([In] ref Guid key, IntPtr value);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetItemByIndex(int index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
        // IMFMediaType
        [PreserveSig] int GetMajorType(out Guid major);
        [PreserveSig] int IsCompressedFormat(out int compressed);
        [PreserveSig] int IsEqual(IntPtr other, out int flags);
        [PreserveSig] int GetRepresentation(Guid representation, out IntPtr value);
        [PreserveSig] int FreeRepresentation(Guid representation, IntPtr value);
    }

    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSample
    {
        [PreserveSig] int GetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int GetItemType([In] ref Guid key, out int type);
        [PreserveSig] int CompareItem([In] ref Guid key, IntPtr value, out int result);
        [PreserveSig] int Compare(IntPtr theirs, int matchType, out int result);
        [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
        [PreserveSig] int GetUINT64([In] ref Guid key, out long value);
        [PreserveSig] int GetDouble([In] ref Guid key, out double value);
        [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
        [PreserveSig] int GetStringLength([In] ref Guid key, out int length);
        [PreserveSig] int GetString([In] ref Guid key, IntPtr buffer, int size, IntPtr length);
        [PreserveSig] int GetAllocatedString([In] ref Guid key, out IntPtr value, out int length);
        [PreserveSig] int GetBlobSize([In] ref Guid key, out int size);
        [PreserveSig] int GetBlob([In] ref Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size, out int written);
        [PreserveSig] int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out int size);
        [PreserveSig] int GetUnknown([In] ref Guid key, [In] ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem([In] ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        [PreserveSig] int SetUINT64([In] ref Guid key, long value);
        [PreserveSig] int SetDouble([In] ref Guid key, double value);
        [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
        [PreserveSig] int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob([In] ref Guid key, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size);
        [PreserveSig] int SetUnknown([In] ref Guid key, IntPtr value);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetItemByIndex(int index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
        // IMFSample
        [PreserveSig] int GetSampleFlags(out int flags);
        [PreserveSig] int SetSampleFlags(int flags);
        [PreserveSig] int GetSampleTime(out long time);
        [PreserveSig] int SetSampleTime(long time);
        [PreserveSig] int GetSampleDuration(out long duration);
        [PreserveSig] int SetSampleDuration(long duration);
        [PreserveSig] int GetBufferCount(out int count);
        [PreserveSig] int GetBufferByIndex(int index, out IMFMediaBuffer buffer);
        [PreserveSig] int ConvertToContiguousBuffer(out IMFMediaBuffer buffer);
        [PreserveSig] int AddBuffer(IMFMediaBuffer buffer);
        [PreserveSig] int RemoveBufferByIndex(int index);
        [PreserveSig] int RemoveAllBuffers();
        [PreserveSig] int GetTotalLength(out int length);
        [PreserveSig] int CopyToBuffer(IMFMediaBuffer buffer);
    }

    [ComImport, Guid("045FA593-8799-42b8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaBuffer
    {
        [PreserveSig] int Lock(out IntPtr buffer, out int maxLength, out int currentLength);
        [PreserveSig] int Unlock();
        [PreserveSig] int GetCurrentLength(out int length);
        [PreserveSig] int SetCurrentLength(int length);
        [PreserveSig] int GetMaxLength(out int length);
    }

    [ComImport, Guid("7FEE9E9A-4A89-47a6-899C-B6A53A70FB67"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFActivate
    {
        [PreserveSig] int GetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int GetItemType([In] ref Guid key, out int type);
        [PreserveSig] int CompareItem([In] ref Guid key, IntPtr value, out int result);
        [PreserveSig] int Compare(IntPtr theirs, int matchType, out int result);
        [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
        [PreserveSig] int GetUINT64([In] ref Guid key, out long value);
        [PreserveSig] int GetDouble([In] ref Guid key, out double value);
        [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
        [PreserveSig] int GetStringLength([In] ref Guid key, out int length);
        [PreserveSig] int GetString([In] ref Guid key, IntPtr buffer, int size, IntPtr length);
        [PreserveSig] int GetAllocatedString([In] ref Guid key, out IntPtr value, out int length);
        [PreserveSig] int GetBlobSize([In] ref Guid key, out int size);
        [PreserveSig] int GetBlob([In] ref Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size, out int written);
        [PreserveSig] int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out int size);
        [PreserveSig] int GetUnknown([In] ref Guid key, [In] ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem([In] ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        [PreserveSig] int SetUINT64([In] ref Guid key, long value);
        [PreserveSig] int SetDouble([In] ref Guid key, double value);
        [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
        [PreserveSig] int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob([In] ref Guid key, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size);
        [PreserveSig] int SetUnknown([In] ref Guid key, IntPtr value);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetItemByIndex(int index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
        // IMFActivate
        [PreserveSig] int ActivateObject([In] ref Guid riid, out IntPtr ppv);
        [PreserveSig] int ShutdownObject();
        [PreserveSig] int DetachObject();
    }

    [ComImport, Guid("DF598932-F10C-4E39-BBA2-C308F101DAA3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaEvent
    {
        [PreserveSig] int GetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int GetItemType([In] ref Guid key, out int type);
        [PreserveSig] int CompareItem([In] ref Guid key, IntPtr value, out int result);
        [PreserveSig] int Compare(IntPtr theirs, int matchType, out int result);
        [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
        [PreserveSig] int GetUINT64([In] ref Guid key, out long value);
        [PreserveSig] int GetDouble([In] ref Guid key, out double value);
        [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
        [PreserveSig] int GetStringLength([In] ref Guid key, out int length);
        [PreserveSig] int GetString([In] ref Guid key, IntPtr buffer, int size, IntPtr length);
        [PreserveSig] int GetAllocatedString([In] ref Guid key, out IntPtr value, out int length);
        [PreserveSig] int GetBlobSize([In] ref Guid key, out int size);
        [PreserveSig] int GetBlob([In] ref Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size, out int written);
        [PreserveSig] int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out int size);
        [PreserveSig] int GetUnknown([In] ref Guid key, [In] ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem([In] ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem([In] ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        [PreserveSig] int SetUINT64([In] ref Guid key, long value);
        [PreserveSig] int SetDouble([In] ref Guid key, double value);
        [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
        [PreserveSig] int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob([In] ref Guid key, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, int size);
        [PreserveSig] int SetUnknown([In] ref Guid key, IntPtr value);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetItemByIndex(int index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
        // IMFMediaEvent
        [PreserveSig] int GetEventType(out int type);
        [PreserveSig] int GetExtendedType(out Guid type);
        [PreserveSig] int GetStatus(out int status);
        [PreserveSig] int GetValue(IntPtr value);
    }

    [ComImport, Guid("2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaEventGenerator
    {
        [PreserveSig] int GetEvent(int flags, out IMFMediaEvent evt);
        [PreserveSig] int BeginGetEvent(IntPtr callback, IntPtr state);
        [PreserveSig] int EndGetEvent(IntPtr result, out IntPtr evt);
        [PreserveSig] int QueueEvent(int type, [In] ref Guid extendedType, int status, IntPtr value);
    }

    [ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFTransform
    {
        [PreserveSig] int GetStreamLimits(out int inMin, out int inMax, out int outMin, out int outMax);
        [PreserveSig] int GetStreamCount(out int inputs, out int outputs);
        [PreserveSig] int GetStreamIDs(int inSize, IntPtr inIds, int outSize, IntPtr outIds);
        [PreserveSig] int GetInputStreamInfo(int id, out MFT_INPUT_STREAM_INFO info);
        [PreserveSig] int GetOutputStreamInfo(int id, out MFT_OUTPUT_STREAM_INFO info);
        [PreserveSig] int GetAttributes(out IMFAttributes attributes);
        [PreserveSig] int GetInputStreamAttributes(int id, out IMFAttributes attributes);
        [PreserveSig] int GetOutputStreamAttributes(int id, out IMFAttributes attributes);
        [PreserveSig] int DeleteInputStream(int id);
        [PreserveSig] int AddInputStreams(int count, IntPtr ids);
        [PreserveSig] int GetInputAvailableType(int id, int index, out IMFMediaType type);
        [PreserveSig] int GetOutputAvailableType(int id, int index, out IMFMediaType type);
        [PreserveSig] int SetInputType(int id, IMFMediaType type, int flags);
        [PreserveSig] int SetOutputType(int id, IMFMediaType type, int flags);
        [PreserveSig] int GetInputCurrentType(int id, out IMFMediaType type);
        [PreserveSig] int GetOutputCurrentType(int id, out IMFMediaType type);
        [PreserveSig] int GetInputStatus(int id, out int flags);
        [PreserveSig] int GetOutputStatus(out int flags);
        [PreserveSig] int SetOutputBounds(long lower, long upper);
        [PreserveSig] int ProcessEvent(int id, IntPtr evt);
        [PreserveSig] int ProcessMessage(int message, IntPtr param);
        [PreserveSig] int ProcessInput(int id, IMFSample sample, int flags);
        [PreserveSig] int ProcessOutput(int flags, int count, [In, Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] MFT_OUTPUT_DATA_BUFFER[] buffers, out int status);
    }

    [ComImport, Guid("eb533d5d-2db6-40f8-97a9-494692014f07"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFDXGIDeviceManager
    {
        [PreserveSig] int CloseDeviceHandle(IntPtr device);
        [PreserveSig] int GetVideoService(IntPtr device, [In] ref Guid riid, out IntPtr service);
        [PreserveSig] int LockDevice(IntPtr device, [In] ref Guid riid, int block, out IntPtr unk);
        [PreserveSig] int OpenDeviceHandle(out IntPtr device);
        [PreserveSig] int ResetDevice(IntPtr device, int resetToken);
        [PreserveSig] int TestDevice(IntPtr device);
        [PreserveSig] int UnlockDevice(IntPtr device, int saveState);
    }

    [ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICodecAPI
    {
        [PreserveSig] int IsSupported([In] ref Guid api);
        [PreserveSig] int IsModifiable([In] ref Guid api);
        [PreserveSig] int GetParameterRange([In] ref Guid api, IntPtr min, IntPtr max, IntPtr step);
        [PreserveSig] int GetParameterValues([In] ref Guid api, IntPtr values, IntPtr count);
        [PreserveSig] int GetDefaultValue([In] ref Guid api, IntPtr value);
        [PreserveSig] int GetValue([In] ref Guid api, IntPtr value);
        [PreserveSig] int SetValue([In] ref Guid api, [In, MarshalAs(UnmanagedType.Struct)] ref object value);
    }

    [ComImport, Guid("97ec2ea4-0e42-4937-97ac-9d6d328824e1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFShutdown
    {
        [PreserveSig] int Shutdown();
        [PreserveSig] int GetShutdownStatus(out int status);
    }

    [ComImport, Guid("A3F675D5-6119-4f7f-A100-1D8B280F0EFB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFVideoProcessorControl
    {
        [PreserveSig] int SetBorderColor(IntPtr color);
        [PreserveSig] int SetSourceRectangle([In] ref RECT rect);
        [PreserveSig] int SetDestinationRectangle([In] ref RECT rect);
        [PreserveSig] int SetMirror(int mirror);
        [PreserveSig] int SetRotation(int rotation);
        [PreserveSig] int SetConstrictionSize(IntPtr size);
    }

    static class MFApi
    {
        public const int MF_VERSION = 0x00020070;
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFStartup(int version, int flags);
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFShutdown();
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFCreateMediaType(out IMFMediaType type);
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFCreateSample(out IMFSample sample);
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFCreateMemoryBuffer(int maxLength, out IMFMediaBuffer buffer);
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFCreateDXGISurfaceBuffer([In] ref Guid riid, IntPtr surface, int subresource, bool bottomUp, out IMFMediaBuffer buffer);
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFCreateDXGIDeviceManager(out int resetToken, out IMFDXGIDeviceManager manager);
        [DllImport("mfplat.dll", ExactSpelling = true)] public static extern int MFTEnumEx(Guid category, int flags, [In] ref MFT_REGISTER_TYPE_INFO input, [In] ref MFT_REGISTER_TYPE_INFO output, out IntPtr activates, out int count);
    }

    // ---------------------------------------------------------------- Direct3D 11 / DXGI
    [StructLayout(LayoutKind.Sequential)]
    struct D3D11_TEXTURE2D_DESC
    {
        public int Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags;
    }

    [ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ID3D11Device
    {
        void CreateBuffer();
        void CreateTexture1D();
        [PreserveSig] int CreateTexture2D([In] ref D3D11_TEXTURE2D_DESC desc, IntPtr initialData, out IntPtr texture);
    }

    [ComImport, Guid("9B7E4E00-342C-4106-A19F-4F2704F689F0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ID3D10Multithread
    {
        void Enter();
        void Leave();
        [PreserveSig] int SetMultithreadProtected(int protect);
        [PreserveSig] int GetMultithreadProtected();
    }

    [ComImport, Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIDevice
    {
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        [PreserveSig] int GetAdapter(out IntPtr adapter);
        void CreateSurface();
        void QueryResourceResidency();
        [PreserveSig] int SetGPUThreadPriority(int priority);
        [PreserveSig] int GetGPUThreadPriority(out int priority);
    }

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIFactory1
    {
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        void EnumAdapters();
        void MakeWindowAssociation();
        void GetWindowAssociation();
        void CreateSwapChain();
        void CreateSoftwareAdapter();
        [PreserveSig] int EnumAdapters1(int index, out IntPtr adapter);
        [PreserveSig] int IsCurrent();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DXGI_ADAPTER_DESC1
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public int VendorId, DeviceId, SubSysId, Revision;
        public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public long AdapterLuid;
        public int Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DXGI_OUTPUT_DESC
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public RECT DesktopCoordinates;
        public int AttachedToDesktop;
        public int Rotation;
        public IntPtr Monitor;
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIAdapter1
    {
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        [PreserveSig] int EnumOutputs(int index, out IntPtr output);
        void GetDesc();
        void CheckInterfaceSupport();
        [PreserveSig] int GetDesc1(out DXGI_ADAPTER_DESC1 desc);
    }

    [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIOutput
    {
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        [PreserveSig] int GetDesc(out DXGI_OUTPUT_DESC desc);
    }

    static class Dx
    {
        public const int DRIVER_TYPE_UNKNOWN = 0;
        public const int DRIVER_TYPE_HARDWARE = 1;
        public const int CREATE_DEVICE_BGRA_SUPPORT = 0x20;
        public const int CREATE_DEVICE_VIDEO_SUPPORT = 0x800;
        public const int SDK_VERSION = 7;
        public const int DXGI_FORMAT_NV12 = 103;
        public const int BIND_RENDER_TARGET = 0x20;
        public const int BIND_VIDEO_ENCODER = 0x200;
        [DllImport("d3d11.dll", ExactSpelling = true)]
        public static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, int flags, [In] int[] featureLevels, int levels, int sdkVersion, out IntPtr device, out int featureLevel, out IntPtr context);
        [DllImport("d3d11.dll", ExactSpelling = true)]
        public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
        [DllImport("dxgi.dll", ExactSpelling = true)]
        public static extern int CreateDXGIFactory1([In] ref Guid riid, out IntPtr factory);
    }

    // ---------------------------------------------------------------- Windows.Graphics.Capture interop
    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int CreateForWindow(IntPtr window, [In] ref Guid iid, out IntPtr result);
        [PreserveSig] int CreateForMonitor(IntPtr monitor, [In] ref Guid iid, out IntPtr result);
    }

    [ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDirect3DDxgiInterfaceAccess
    {
        [PreserveSig] int GetInterface([In] ref Guid iid, out IntPtr p);
    }

    static class WinRT
    {
        [DllImport("combase.dll", ExactSpelling = true)] public static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int length, out IntPtr hstring);
        [DllImport("combase.dll", ExactSpelling = true)] public static extern int WindowsDeleteString(IntPtr hstring);
        [DllImport("combase.dll", ExactSpelling = true)] public static extern int RoGetActivationFactory(IntPtr classId, [In] ref Guid iid, out IntPtr factory);

        public static object Factory(string className, Guid iid)
        {
            IntPtr h, f;
            HR.Check(WindowsCreateString(className, className.Length, out h), "WindowsCreateString");
            try { HR.Check(RoGetActivationFactory(h, ref iid, out f), "RoGetActivationFactory " + className); }
            finally { WindowsDeleteString(h); }
            try { return Marshal.GetObjectForIUnknown(f); } finally { Marshal.Release(f); }
        }
    }

    // ---------------------------------------------------------------- WASAPI
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate([In] ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out int frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out int frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService([In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
        [PreserveSig] int ReleaseBuffer(int frames);
        [PreserveSig] int GetNextPacketSize(out int frames);
    }

    // ---------------------------------------------------------------- user32 / kernel32
    static class Win32
    {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr process, int flags, System.Text.StringBuilder name, ref int size);
        [DllImport("kernel32.dll")] public static extern bool QueryPerformanceCounter(out long count);
        [DllImport("kernel32.dll")] public static extern bool QueryPerformanceFrequency(out long frequency);
        [DllImport("winmm.dll")] public static extern int timeBeginPeriod(int period);

        public const int MONITOR_DEFAULTTONEAREST = 2;
        public const int GW_OWNER = 4;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x80;
        public const int DWMWA_CLOAKED = 14;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        static long freq;
        /// <summary>Now on the clock Windows.Graphics.Capture and WASAPI stamp their data with, in 100 ns units.</summary>
        public static long Now100ns()
        {
            if (freq == 0) QueryPerformanceFrequency(out freq);
            long c;
            QueryPerformanceCounter(out c);
            return (long)(c * (10000000.0 / freq));
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public int dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public int th32ModuleID, cntThreads, th32ParentProcessID, pcPriClassBase, dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    static class Toolhelp
    {
        public const int TH32CS_SNAPPROCESS = 2;
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(int flags, int pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")] public static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")] public static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    }
}
